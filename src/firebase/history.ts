import {
  collection,
  doc,
  deleteDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './config';
import { COLLECTIONS } from '../shared/constants';
import type { Room, RoomHistoryEntry } from '../shared/types';

// Per-user room history + favourites, stored under the user document.

const historyCol = (uid: string) => collection(db, COLLECTIONS.users, uid, COLLECTIONS.history);
const historyRef = (uid: string, roomId: string) =>
  doc(db, COLLECTIONS.users, uid, COLLECTIONS.history, roomId);

/**
 * Stamp "I was here" for a room. Called whenever a session starts, so the
 * history list reflects attendance rather than just room creation. `merge`
 * keeps an existing `favourite` flag intact.
 */
export function recordAttendance(uid: string, room: Room): Promise<void> {
  return setDoc(
    historyRef(uid, room.id),
    {
      roomId: room.id,
      roomName: room.name,
      pageUrl: room.pageUrl,
      roomCreatedAt: room.createdAt ?? null,
      lastAttendedAt: serverTimestamp(),
    },
    { merge: true },
  ).catch(() => undefined);
}

export function setFavourite(uid: string, roomId: string, favourite: boolean): Promise<void> {
  return updateDoc(historyRef(uid, roomId), { favourite }).catch(() => undefined);
}

export function removeFromHistory(uid: string, roomId: string): Promise<void> {
  return deleteDoc(historyRef(uid, roomId)).catch(() => undefined);
}

function entryFromSnap(id: string, data: any): RoomHistoryEntry {
  return {
    roomId: data.roomId ?? id,
    roomName: data.roomName ?? 'Untitled room',
    pageUrl: data.pageUrl ?? '',
    favourite: !!data.favourite,
    lastAttendedAt: data.lastAttendedAt?.toMillis?.() ?? null,
    roomCreatedAt: data.roomCreatedAt?.toMillis?.() ?? null,
  };
}

/** Live history for a user, most recently attended first. */
export function watchHistory(
  uid: string,
  cb: (entries: RoomHistoryEntry[]) => void,
  max = 200,
): Unsubscribe {
  const q = query(historyCol(uid), orderBy('lastAttendedAt', 'desc'), limit(max));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => entryFromSnap(d.id, d.data()))));
}
