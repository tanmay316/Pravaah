/**
 * Pravaah — Firebase Auth (Web)
 *
 * Web counterpart of lib/firebase.ts. Metro resolves this file for Platform.OS === "web",
 * so the exported surface MUST stay in sync with lib/firebase.ts.
 *
 * There is deliberately no "demo/mock user" fallback: it made getIdToken() resolve before
 * Firebase had restored the persisted session, so the first dashboard fetch of every page
 * load was attributed to a throwaway demo uid (hence "diagnostic pending" / empty plan).
 */

import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  GoogleAuthProvider,
  updateProfile,
  signOut as firebaseSignOut,
  Auth,
  User,
} from "firebase/auth";
import { useEffect, useState } from "react";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
} else {
  console.error(
    "Firebase web config missing. Set EXPO_PUBLIC_FIREBASE_API_KEY / _PROJECT_ID / _AUTH_DOMAIN / _APP_ID."
  );
}

/**
 * Resolves once Firebase has finished restoring any persisted session.
 * Anything that needs a uid or an ID token must await this first.
 */
let authReadyPromise: Promise<User | null> | null = null;

export function authReady(): Promise<User | null> {
  if (!auth) return Promise.resolve(null);
  if (!authReadyPromise) {
    authReadyPromise = new Promise<User | null>((resolve) => {
      const unsubscribe = onAuthStateChanged(
        auth!,
        (user) => {
          unsubscribe();
          resolve(user);
        },
        () => {
          unsubscribe();
          resolve(null);
        }
      );
    });
  }
  return authReadyPromise;
}

function requireAuth(): Auth {
  if (!auth) {
    throw new Error("Sign-in is unavailable because Firebase is not configured.");
  }
  return auth;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return { user, loading };
}

export async function signInWithEmail(email: string, password: string) {
  return signInWithEmailAndPassword(requireAuth(), email, password);
}

export async function signUpWithEmail(email: string, password: string, displayName?: string) {
  const credential = await createUserWithEmailAndPassword(requireAuth(), email, password);
  if (displayName?.trim() && credential.user) {
    await updateProfile(credential.user, { displayName: displayName.trim() });
  }
  return credential;
}

/**
 * Send a password reset email. Firebase always resolves successfully even for an
 * unregistered address, so the UI can show one neutral message regardless and avoid
 * leaking which emails have accounts.
 */
export async function sendPasswordReset(email: string) {
  return sendPasswordResetEmail(requireAuth(), email);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(requireAuth(), provider);
}

export async function signOut() {
  if (!auth) return;
  authReadyPromise = null;
  await firebaseSignOut(auth);
}

export async function getIdToken(): Promise<string | null> {
  if (!auth) return null;
  const user = auth.currentUser ?? (await authReady());
  if (!user) return null;
  return user.getIdToken();
}

export function getCurrentUser(): User | null {
  return auth?.currentUser ?? null;
}
