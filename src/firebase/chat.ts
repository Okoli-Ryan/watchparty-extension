import {
  addDoc,
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './config';
import { COLLECTIONS, CHAT_PAGE_SIZE } from '../shared/constants';
import { decryptText, encryptText } from '../shared/crypto';
import type { ChatMessage, UserProfile } from '../shared/types';

const messagesCol = (roomId: string) =>
  collection(db, COLLECTIONS.rooms, roomId, COLLECTIONS.messages);

/**
 * Encrypt and post a chat message. Only `senderUid`/`senderName` and the
 * timestamp are stored in the clear — the body is AES-GCM ciphertext.
 */
export async function sendMessage(
  roomId: string,
  key: CryptoKey,
  sender: UserProfile,
  text: string,
): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const { iv, ct } = await encryptText(key, body);
  await addDoc(messagesCol(roomId), {
    senderUid: sender.uid,
    senderName: sender.displayName,
    iv,
    ct,
    createdAt: serverTimestamp(),
  });
}

/**
 * Subscribe to a room's chat, decrypting as messages arrive. A message that
 * fails to decrypt (key rotated, corrupt payload) is surfaced as a placeholder
 * rather than dropped, so the transcript never silently loses entries.
 */
export function watchMessages(
  roomId: string,
  key: CryptoKey,
  cb: (messages: ChatMessage[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(messagesCol(roomId), orderBy('createdAt', 'desc'), limit(CHAT_PAGE_SIZE));

  // Decryption is async, so two snapshots arriving close together can settle out
  // of order and an older list would overwrite a newer one — dropping the very
  // message that triggered the update. Sequence them and ignore late arrivals.
  let issued = 0;
  let delivered = 0;

  return onSnapshot(
    q,
    async (snap) => {
    const seq = ++issued;
    const out = await Promise.all(
      snap.docs.map(async (d) => {
        const data = d.data();
        let text: string;
        try {
          text = await decryptText(key, { iv: data.iv, ct: data.ct });
        } catch {
          text = '🔒 (could not decrypt)';
        }
        return {
          id: d.id,
          senderUid: data.senderUid,
          senderName: data.senderName ?? 'Someone',
          text,
          at: data.createdAt?.toMillis?.() ?? Date.now(),
        } as ChatMessage;
      }),
    );
      if (seq < delivered) return; // a newer snapshot already landed
      delivered = seq;
      // Query is newest-first for the limit; present oldest-first for reading.
      cb(out.reverse());
    },
    // Without this, a permission-denied (rules not deployed) fails completely
    // silently and chat just looks broken.
    (err) => onError?.(err),
  );
}
