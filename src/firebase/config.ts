import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  type Auth,
} from 'firebase/auth';

// ---------------------------------------------------------------------------
// Firebase project configuration.
//
// These values are NOT secrets — a Firebase web config is safe to ship in a
// client bundle; access is gated by Firebase Auth + Firestore security rules
// (see firestore.rules). Fill these in from your Firebase console:
//   Project settings → General → Your apps → Web app → SDK setup & config.
// You can also override any value at build time via a Vite env var
// (e.g. VITE_FB_API_KEY) in a local .env file — see .env.example.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FB_API_KEY ?? 'YOUR_API_KEY',
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN ?? 'YOUR_PROJECT.firebaseapp.com',
  projectId: import.meta.env.VITE_FB_PROJECT_ID ?? 'YOUR_PROJECT_ID',
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET ?? 'YOUR_PROJECT.appspot.com',
  messagingSenderId: import.meta.env.VITE_FB_SENDER_ID ?? 'YOUR_SENDER_ID',
  appId: import.meta.env.VITE_FB_APP_ID ?? 'YOUR_APP_ID',
};

// Primary app — used everywhere for the logged-in session.
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// indexedDBLocalPersistence works in BOTH the popup (window) and the background
// service worker (no localStorage there), and — because both run at the same
// chrome-extension:// origin — they share one persisted session. That's what
// lets the popup log in and the service worker use that same session for the
// realtime Firestore work.
export const auth: Auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence],
});

/**
 * Run a callback against a throwaway secondary Firebase app. Used by the admin
 * "create user" flow: `createUserWithEmailAndPassword` signs the new user into
 * whatever Auth instance it runs on, which would boot the admin out of their
 * own session. Running it on a secondary app with in-memory persistence keeps
 * the admin's primary session untouched, and we delete the app afterwards.
 */
export async function withSecondaryApp<T>(
  fn: (secondaryAuth: Auth) => Promise<T>,
): Promise<T> {
  const name = `admin-worker-${Date.now()}`;
  let secondary: FirebaseApp | undefined;
  try {
    secondary = initializeApp(firebaseConfig, name);
    const secondaryAuth = getAuth(secondary);
    // Never persist the throwaway session.
    await secondaryAuth.setPersistence(inMemoryPersistence);
    return await fn(secondaryAuth);
  } finally {
    if (secondary) await deleteApp(secondary).catch(() => undefined);
  }
}
