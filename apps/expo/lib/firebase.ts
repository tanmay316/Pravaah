/**
 * Firebase initialization for the Expo app.
 *
 * Uses @react-native-firebase/app and @react-native-firebase/auth.
 * Firebase client config comes from the native google-services files
 * configured during `expo prebuild`. For web, it reads EXPO_PUBLIC_ env vars.
 *
 * NEVER import server secrets here.
 */

import auth, { FirebaseAuthTypes } from "@react-native-firebase/auth";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import { useEffect, useState } from "react";

/**
 * Firebase verifies Google ID tokens against the project's OAuth *web* client. Prefer the
 * env var; otherwise read it from google-services.json (present once Google sign-in is
 * enabled in the Firebase console and the file is re-downloaded).
 */
function googleWebClientId(): string | undefined {
  if (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) return process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  try {
    const services = require("../google-services.json");
    for (const client of services.client ?? []) {
      const web = (client.oauth_client ?? []).find((c: any) => c.client_type === 3);
      if (web?.client_id) return web.client_id;
    }
  } catch {}
  return undefined;
}

let googleConfigured = false;

/**
 * Resolves once Firebase has finished restoring any persisted session.
 * Anything that needs a uid or an ID token must await this first.
 */
let authReadyPromise: Promise<FirebaseAuthTypes.User | null> | null = null;

export function authReady(): Promise<FirebaseAuthTypes.User | null> {
  if (!authReadyPromise) {
    authReadyPromise = new Promise((resolve) => {
      const unsubscribe = auth().onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user);
      });
    });
  }
  return authReadyPromise;
}

/**
 * Hook that tracks Firebase Auth state.
 * Returns the current user (or null) and a loading flag.
 */
export function useAuth() {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth().onAuthStateChanged((firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return { user, loading };
}

/**
 * Sign in with email and password.
 */
export async function signInWithEmail(email: string, password: string) {
  return auth().signInWithEmailAndPassword(email, password);
}

/**
 * Create a new account with email and password.
 */
export async function signUpWithEmail(email: string, password: string, displayName?: string) {
  const credential = await auth().createUserWithEmailAndPassword(email, password);
  if (displayName?.trim() && credential.user) {
    await credential.user.updateProfile({ displayName: displayName.trim() });
  }
  return credential;
}

/**
 * Send a password reset email. Firebase always resolves successfully even for an
 * unregistered address, so the UI can show one neutral message regardless and avoid
 * leaking which emails have accounts.
 */
export async function sendPasswordReset(email: string) {
  return auth().sendPasswordResetEmail(email);
}

/**
 * Native Google sign-in: Google Sign-In SDK for the ID token, then a Firebase credential.
 * (Web uses lib/firebase.web.ts.)
 */
export async function signInWithGoogle() {
  if (!googleConfigured) {
    const webClientId = googleWebClientId();
    if (!webClientId) {
      throw new Error(
        "Google sign-in is not set up yet. Enable Google in Firebase Authentication, then rebuild the app."
      );
    }
    GoogleSignin.configure({ webClientId });
    googleConfigured = true;
  }

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new Error("Google sign-in was cancelled.");
    }
    const idToken = response.data.idToken;
    if (!idToken) {
      throw new Error("Google did not return an ID token. Check the web client ID.");
    }
    return await auth().signInWithCredential(auth.GoogleAuthProvider.credential(idToken));
  } catch (err: any) {
    if (isErrorWithCode(err)) {
      if (err.code === statusCodes.SIGN_IN_CANCELLED) throw new Error("Google sign-in was cancelled.");
      if (err.code === statusCodes.IN_PROGRESS) throw new Error("Google sign-in is already in progress.");
      if (err.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        throw new Error("Google Play Services is unavailable or outdated on this device.");
      }
      // DEVELOPER_ERROR: this build's signing SHA-1 is not registered in Firebase.
      if (String(err.code) === "10" || /DEVELOPER_ERROR/i.test(err.message ?? "")) {
        throw new Error(
          "Google sign-in is misconfigured: add this build's SHA-1 fingerprint to the Firebase Android app."
        );
      }
    }
    console.warn("Native Google Auth error:", err);
    throw err;
  }
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  authReadyPromise = null;
  // Clear the cached Google account so the account picker shows next time.
  if (googleConfigured) await GoogleSignin.signOut().catch(() => {});
  return auth().signOut();
}

/**
 * Get the current user's Firebase ID token for API requests.
 * Waits for the persisted session to be restored before giving up.
 */
export async function getIdToken(): Promise<string | null> {
  const currentUser = auth().currentUser ?? (await authReady());
  if (!currentUser) return null;
  return currentUser.getIdToken();
}

export function getCurrentUser(): FirebaseAuthTypes.User | null {
  return auth().currentUser;
}
