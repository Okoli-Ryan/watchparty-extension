import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, withSecondaryApp } from './config';
import { COLLECTIONS } from '../shared/constants';
import type { Role, UserProfile } from '../shared/types';

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: Role;
}

/**
 * Admin-only: create a new account without disturbing the admin's own session.
 *
 * `createUserWithEmailAndPassword` signs the new user into whatever Auth
 * instance runs it, so we run it on a disposable secondary app. We then write
 * the `users/{uid}` profile doc from the PRIMARY session (the admin), which is
 * what Firestore rules authorize (`isAdmin()`).
 */
export async function createUser(input: CreateUserInput): Promise<UserProfile> {
  const email = input.email.trim();
  const displayName = input.displayName.trim() || email;

  const uid = await withSecondaryApp(async (secondaryAuth) => {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, input.password);
    const newUid = cred.user.uid;
    // Sign the throwaway session out immediately; the app is deleted after.
    await signOut(secondaryAuth).catch(() => undefined);
    return newUid;
  });

  // Written by the admin's primary session → passes the isAdmin() rule.
  await setDoc(doc(db, COLLECTIONS.users, uid), {
    email,
    displayName,
    role: input.role,
    createdAt: serverTimestamp(),
  });

  return { uid, email, displayName, role: input.role };
}
