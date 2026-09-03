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

/**
 * Record how far this user has read a room's chat, as the epoch ms of the newest
 * message they have seen.
 *
 * `setDoc(..., merge)` rather than `updateDoc`: the history entry may not exist
 * yet for a room being observed from the dashboard without ever having joined it
 * from the extension.
 */
export function markRead(uid: string, roomId: string, at: number): Promise<void> {
  return setDoc(historyRef(uid, roomId), { roomId, lastReadAt: at }, { merge: true }).catch(
    () => undefined,
  );
}

/**
 * Live view of one history entry. The extension watches this so a read that
 * happens in the web dashboard settles the widget's unread badge, and vice versa.
 */
export function watchHistoryEntry(
  uid: string,
  roomId: string,
  cb: (entry: RoomHistoryEntry | null) => void,
): Unsubscribe {
  return onSnapshot(historyRef(uid, roomId), (snap) =>
    cb(snap.exists() ? entryFromSnap(snap.id, snap.data()) : null),
  );
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
    // Written as a plain epoch number, not a Timestamp: it is compared against
    // ChatMessage.at, which is already toMillis()'d.
    lastReadAt: typeof data.lastReadAt === 'number' ? data.lastReadAt : null,
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
