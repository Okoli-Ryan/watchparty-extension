import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './config';
import { COLLECTIONS, ROOM_PAGE_SIZE, ROOM_STALE_MS } from '../shared/constants';
import {
  generateRoomKey,
  generateSalt,
  deriveKeyFromPassphrase,
  makeVerifier,
} from '../shared/crypto';
import type { Room, PlaybackState, UserProfile, RoomVisibility } from '../shared/types';

const roomsCol = () => collection(db, COLLECTIONS.rooms);
const roomRef = (id: string) => doc(db, COLLECTIONS.rooms, id);

function roomFromSnap(id: string, data: any): Room {
  return {
    id,
    name: data.name,
    pageUrl: data.pageUrl,
    selector: data.selector,
    frameOrigin: data.frameOrigin ?? '',
    // Rooms created before visibility existed are public.
    visibility: (data.visibility as Room['visibility']) ?? 'public',
    chatKey: data.chatKey ?? '',
    chatSalt: data.chatSalt ?? '',
    chatCheck: data.chatCheck ?? null,
    ownerUid: data.ownerUid,
    ownerName: data.ownerName,
    // Rooms created before persistent claims existed fall back to the owner.
    primaryOwnerUid: data.primaryOwnerUid ?? data.ownerUid,
    primaryOwnerName: data.primaryOwnerName ?? data.ownerName,
    isActive: data.isActive,
    hostPosition: data.hostPosition ?? null,
    lastActiveAt: data.lastActiveAt ?? null,
    playback: data.playback ?? {
      isPlaying: false,
      currentTime: 0,
      rate: 1,
      updatedAt: null,
      updatedBy: data.ownerUid,
    },
    createdAt: data.createdAt,
  };
}

export interface CreateRoomInput {
  name: string;
  pageUrl: string;
  selector: string;
  frameOrigin: string;
  currentTime: number;
  owner: UserProfile;
  visibility: RoomVisibility;
  /** Required for private rooms; never stored, only used to derive the key. */
  passphrase?: string;
}

/**
 * Build the chat key material for a room.
 *  • public  — random key, stored on the document.
 *  • private — key derived from the passphrase; only the salt and a verifier
 *    are stored, so the key itself never reaches Firestore.
 */
async function buildChatFields(input: CreateRoomInput) {
  if (input.visibility === 'private') {
    const passphrase = input.passphrase?.trim();
    if (!passphrase) throw new Error('A passphrase is required for a private room.');
    const chatSalt = generateSalt();
    const key = await deriveKeyFromPassphrase(passphrase, chatSalt);
    return { chatKey: '', chatSalt, chatCheck: await makeVerifier(key) };
  }
  return { chatKey: generateRoomKey(), chatSalt: '', chatCheck: null };
}

/** Create a new active room owned by `owner`. Returns the new room id. */
export async function createRoom(input: CreateRoomInput): Promise<string> {
  const chat = await buildChatFields(input);
  const playback: PlaybackState = {
    isPlaying: false,
    currentTime: input.currentTime || 0,
    rate: 1,
    updatedAt: null,
    updatedBy: input.owner.uid,
  };
  const ref = await addDoc(roomsCol(), {
    name: input.name.trim() || 'Untitled room',
    pageUrl: input.pageUrl,
    selector: input.selector,
    frameOrigin: input.frameOrigin,
    visibility: input.visibility,
    ...chat,
    ownerUid: input.owner.uid,
    ownerName: input.owner.displayName,
    primaryOwnerUid: input.owner.uid,
    primaryOwnerName: input.owner.displayName,
    isActive: true,
    lastActiveAt: serverTimestamp(),
    playback,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getRoom(id: string): Promise<Room | null> {
  const snap = await getDoc(roomRef(id));
  return snap.exists() ? roomFromSnap(snap.id, snap.data()) : null;
}

/**
 * Live list of recent rooms, newest first — both live and ended. The UI splits
 * them with `isRoomLive`, so an ended room shows up under History instead of
 * lingering in the active list forever.
 */
export function watchRooms(cb: (rooms: Room[]) => void): Unsubscribe {
  const q = query(roomsCol(), orderBy('createdAt', 'desc'), limit(ROOM_PAGE_SIZE));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => roomFromSnap(d.id, d.data())));
  });
}

function activityMs(r: Room): number {
  return r.lastActiveAt?.toMillis?.() ?? r.createdAt?.toMillis?.() ?? 0;
}

/**
 * Reference "now" for room liveness. Server timestamps can sit ahead of a skewed
 * client clock, so take the later of the two — the same clock-skew guard used
 * for member presence.
 */
export function roomsRef(rooms: Room[]): number {
  let max = 0;
  for (const r of rooms) max = Math.max(max, activityMs(r));
  return Math.max(Date.now(), max);
}

/** A room is live if it wasn't closed AND its heartbeat is recent. */
export function isRoomLive(room: Room, ref: number): boolean {
  if (room.isActive === false) return false;
  return ref - activityMs(room) < ROOM_STALE_MS;
}

/**
 * Owner-only: point the room at a different video (host switched episode,
 * source or page). Playback is reset to the new video's position so viewers
 * don't inherit a timestamp from the old one.
 */
export function updateRoomVideo(
  roomId: string,
  ownerUid: string,
  video: { pageUrl: string; selector: string; frameOrigin: string; currentTime: number },
): Promise<void> {
  return updateDoc(roomRef(roomId), {
    pageUrl: video.pageUrl,
    selector: video.selector,
    frameOrigin: video.frameOrigin,
    playback: {
      isPlaying: false,
      currentTime: video.currentTime || 0,
      rate: 1,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    },
  });
}

/**
 * Owner-only: stamp the room's liveness heartbeat, and refresh where the host's
 * playhead actually is.
 *
 * `hostPosition` is written here rather than into `playback` on purpose. Sync is
 * event-driven (DECISIONS.md #10) — `playback` changes only when the host ACTS,
 * and folding a periodic position into it would make every refresh look like a
 * host action and yank viewers around on a timer. Kept separate, it is inert to
 * viewers and exists purely so "Sync with host" can measure against something
 * recent instead of extrapolating across minutes.
 */
export function touchRoom(
  roomId: string,
  position?: { currentTime: number; isPlaying: boolean } | null,
): Promise<void> {
  const patch: Record<string, unknown> = { lastActiveAt: serverTimestamp() };
  if (position) {
    patch.hostPosition = { ...position, updatedAt: serverTimestamp() };
  }
  return updateDoc(roomRef(roomId), patch);
}

/** Live subscription to a single room doc. */
export function watchRoom(id: string, cb: (room: Room | null) => void): Unsubscribe {
  return onSnapshot(roomRef(id), (snap) => {
    cb(snap.exists() ? roomFromSnap(snap.id, snap.data()) : null);
  });
}

/** Owner-only: push the latest playback state. */
export function writePlayback(
  roomId: string,
  ownerUid: string,
  state: { isPlaying: boolean; currentTime: number; rate: number },
): Promise<void> {
  return updateDoc(roomRef(roomId), {
    playback: {
      isPlaying: state.isPlaying,
      currentTime: state.currentTime,
      rate: state.rate,
      updatedAt: serverTimestamp(),
      updatedBy: ownerUid,
    },
  });
}

/**
 * Reassign the *current* owner without touching the persistent claim. Used for
 * automatic handoff when the host leaves — so the original host still reclaims
 * the room if they return.
 */
export function setOwner(roomId: string, uid: string, name: string): Promise<void> {
  return updateDoc(roomRef(roomId), { ownerUid: uid, ownerName: name });
}

/**
 * Deliberately hand the room to someone else. This moves the persistent claim
 * too, so the previous host won't reclaim it on their next visit.
 */
export function transferOwnership(roomId: string, uid: string, name: string): Promise<void> {
  return updateDoc(roomRef(roomId), {
    ownerUid: uid,
    ownerName: name,
    primaryOwnerUid: uid,
    primaryOwnerName: name,
  });
}

/** Mark a room inactive (last member left). */
export function deactivateRoom(roomId: string): Promise<void> {
  return updateDoc(roomRef(roomId), { isActive: false });
}
