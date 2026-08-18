import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from './config';
import { COLLECTIONS } from '../shared/constants';
import type { UserProfile, Role } from '../shared/types';

/** Sign in an existing account. Accounts are created by an admin (see users.ts). */
export async function login(email: string, password: string): Promise<UserProfile> {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  const profile = await getProfile(cred.user.uid);
  if (!profile) {
    // Auth account exists but no users/{uid} doc — treat as misconfigured.
    await signOut(auth);
    throw new Error('No profile found for this account. Ask an admin to set it up.');
  }
  return profile;
}

export function logout(): Promise<void> {
  return signOut(auth);
}

export async function getProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, COLLECTIONS.users, uid));
  if (!snap.exists()) return null;
  const data = snap.data();
  return {
    uid,
    email: data.email,
    displayName: data.displayName ?? data.email,
    role: (data.role as Role) ?? 'user',
    createdAt: data.createdAt,
  };
}

/** Subscribe to auth changes; callback receives the resolved profile (or null). */
export function watchAuth(cb: (profile: UserProfile | null, user: User | null) => void) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return cb(null, null);
    const profile = await getProfile(user.uid);
    cb(profile, user);
  });
}
