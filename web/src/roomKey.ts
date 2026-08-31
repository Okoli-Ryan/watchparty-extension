import {
  importRoomKey,
  deriveKeyFromPassphrase,
  checkVerifier,
} from '../../src/shared/crypto';
import type { Room } from '../../src/shared/types';

// Resolving a room's chat key, mirroring the service worker's resolveChatKey().
//
//  • public  — the key is stored on the room document, so anyone who can read
//    the room can read its chat. That is the documented trade-off (DECISIONS #13),
//    not a flaw in this client.
//  • private — the key is derived from a passphrase that is never stored
//    anywhere. Without it there is nothing this dashboard can show.

export type KeyState =
  /** Chat is readable. */
  | { status: 'ready'; key: CryptoKey }
  /** Private room, no passphrase supplied yet. */
  | { status: 'locked' }
  /** Private room, the passphrase did not verify. */
  | { status: 'wrong' }
  /** Public room created before chat existed — nothing to decrypt with. */
  | { status: 'none' };

export async function resolveRoomKey(room: Room, passphrase?: string): Promise<KeyState> {
  if (room.visibility !== 'private') {
    if (!room.chatKey) return { status: 'none' };
    const key = await importRoomKey(room.chatKey).catch(() => null);
    return key ? { status: 'ready', key } : { status: 'none' };
  }
  const pass = passphrase?.trim();
  if (!pass) return { status: 'locked' };
  const key = await deriveKeyFromPassphrase(pass, room.chatSalt).catch(() => null);
  // A wrong passphrase derives a valid-looking key that fails GCM's auth tag on
  // the stored sentinel — which is exactly what we are testing for.
  if (!key || !(await checkVerifier(key, room.chatCheck))) return { status: 'wrong' };
  return { status: 'ready', key };
}

// Passphrases are held for the tab session only, so switching between rooms
// doesn't re-prompt. sessionStorage, never localStorage: it should not outlive
// the tab, and it must never reach Firestore.
const passKey = (roomId: string) => `watchparty:pass:${roomId}`;

export function rememberPassphrase(roomId: string, passphrase: string) {
  try {
    sessionStorage.setItem(passKey(roomId), passphrase);
  } catch {
    /* private browsing / storage disabled — re-prompting is an acceptable cost */
  }
}

export function recallPassphrase(roomId: string): string | undefined {
  try {
    return sessionStorage.getItem(passKey(roomId)) ?? undefined;
  } catch {
    return undefined;
  }
}
