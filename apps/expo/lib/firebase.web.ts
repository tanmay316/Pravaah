import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  User
} from "firebase/auth";
import { useEffect, useState } from "react";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || "AIzaSyMockKeyForDev123456789",
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || "pravaah-cabaa.firebaseapp.com",
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || "pravaah-cabaa",
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || "1:190737957549:web:644750a62cd69c203f3c24",
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || "pravaah-cabaa.firebasestorage.app",
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "190737957549",
};

let app: any = null;
let auth: any = null;

try {
  app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
  auth = getAuth(app);
} catch (e) {
  console.warn("Firebase web initialization notice:", e);
}

// Local mock user state for demo / offline
let mockUser: any = {
  uid: "demo_learner_2026",
  email: "demo.learner@pravaah.ai",
  displayName: "Demo Learner",
  getIdToken: async () => "demo_mock_token_2026",
};

const listeners = new Set<(user: any) => void>();

export function useAuth() {
  const [user, setUser] = useState<User | null>(mockUser);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (auth) {
      try {
        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
          if (firebaseUser) {
            setUser(firebaseUser);
          } else {
            setUser(mockUser);
          }
          setLoading(false);
        });
        return unsubscribe;
      } catch (err) {
        setUser(mockUser);
        setLoading(false);
      }
    } else {
      setUser(mockUser);
      setLoading(false);
    }
  }, []);

  return { user, loading };
}

export async function signInWithEmail(email: string, password: string) {
  if (auth) {
    try {
      return await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      // Fallback for demo credentials
      if (email.includes("demo")) {
        mockUser = { uid: "demo_learner_2026", email, getIdToken: async () => "demo_token" };
        listeners.forEach((cb) => cb(mockUser));
        return { user: mockUser };
      }
      throw err;
    }
  }
  mockUser = { uid: "demo_learner_2026", email, getIdToken: async () => "demo_token" };
  listeners.forEach((cb) => cb(mockUser));
  return { user: mockUser };
}

export async function signUpWithEmail(email: string, password: string) {
  if (auth) {
    try {
      return await createUserWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      if (email.includes("demo")) {
        mockUser = { uid: "demo_learner_2026", email, getIdToken: async () => "demo_token" };
        return { user: mockUser };
      }
      throw err;
    }
  }
  mockUser = { uid: "demo_learner_2026", email, getIdToken: async () => "demo_token" };
  return { user: mockUser };
}

export async function signOut() {
  if (auth) {
    try {
      await firebaseSignOut(auth);
    } catch {}
  }
  mockUser = null;
  listeners.forEach((cb) => cb(null));
}

export async function getIdToken(): Promise<string | null> {
  if (auth?.currentUser) {
    try {
      return await auth.currentUser.getIdToken();
    } catch {}
  }
  return mockUser?.getIdToken ? await mockUser.getIdToken() : "demo_token";
}
