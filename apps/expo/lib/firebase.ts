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
import { useEffect, useState } from "react";
import { Platform } from "react-native";

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
 * Sign in with Google Auth provider.
 */
export async function signInWithGoogle() {
  if (Platform.OS === "web") {
    try {
      const { getAuth, signInWithPopup, GoogleAuthProvider } = require("firebase/auth");
      const { initializeApp, getApps } = require("firebase/app");
      const firebaseConfig = {
        apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
        storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
      };
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
      const webAuth = getAuth(app);
      const provider = new GoogleAuthProvider();
      return await signInWithPopup(webAuth, provider);
    } catch (err) {
      console.warn("Web Google Auth error:", err);
      throw err;
    }
  }

  // Native mobile fallback
  try {
    const provider = new (auth as any).GoogleAuthProvider();
    return await (auth() as any).signInWithProvider(provider);
  } catch (err) {
    console.warn("Native Google Auth error:", err);
    throw err;
  }
}

/**
 * Sign out the current user.
 */
export async function signOut() {
  authReadyPromise = null;
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
