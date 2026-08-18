import type { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'user';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt?: Timestamp;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  rate: number;
  updatedAt: Timestamp | null;
  updatedBy: string; // uid of the owner who last wrote this
}

export type RoomStatus = 'active' | 'inactive';

export type RoomVisibility = 'public' | 'private';

export interface Room {
  id: string;
  name: string;
  /** Top-level page URL a joining viewer navigates to. */
  pageUrl: string;
  /** CSS selector for the video, relative to `frameOrigin`'s document. */
  selector: string;
  /** Origin of the frame holding the video; '' means the top document. */
  frameOrigin: string;
  /**
   * `public`  — the chat key is stored on this document (convenient: joining is
   *             one click, and the console still shows only ciphertext).
   * `private` — the key is derived from a passphrase that is NEVER stored, so
   *             nobody with database access can decrypt. Joining requires it.
   */
  visibility: RoomVisibility;
  /** Base64 AES-GCM key. Public rooms only — empty for private rooms. */
  chatKey: string;
  /** PBKDF2 salt for passphrase derivation. Private rooms only. */
  chatSalt: string;
  /** Known plaintext encrypted with the room key, to validate a passphrase. */
  chatCheck: { iv: string; ct: string } | null;
  /** Who currently drives playback (may change automatically on exit). */
  ownerUid: string;
  ownerName: string;
  /**
   * Who holds the *persistent* claim to be host — the room's creator, unless
   * ownership was handed over deliberately. Automatic handoff (leaving,
   * crashing) never moves this, so the original host reclaims the room when
   * they come back. A manual transfer moves it for good.
   */
  primaryOwnerUid: string;
  primaryOwnerName: string;
  isActive: boolean;
  /** Owner-stamped liveness heartbeat; absence/staleness means the room ended. */
  lastActiveAt?: Timestamp | null;
  playback: PlaybackState;
  createdAt?: Timestamp;
}

/** A decrypted chat message, as handed to the UI. */
export interface ChatMessage {
  id: string;
  senderUid: string;
  senderName: string;
  text: string;
  /** Epoch millis — Firestore Timestamps don't survive extension messaging. */
  at: number;
}

/**
 * Per-user record of a room they've been in. Kept under the user rather than
 * the room because "when did *I* last watch this" and "is this one of *my*
 * favourites" are per-person, and because member docs are pruned on exit.
 */
export interface RoomHistoryEntry {
  roomId: string;
  roomName: string;
  pageUrl: string;
  favourite: boolean;
  /** When this user last joined the room. */
  lastAttendedAt: number | null;
  /** When the room itself was created (denormalised for the history list). */
  roomCreatedAt: number | null;
}

export type MemberRole = 'owner' | 'viewer';

export interface Member {
  uid: string;
  displayName: string;
  role: MemberRole;
  joinedAt: Timestamp | null;
  lastSeen: Timestamp | null;
}
