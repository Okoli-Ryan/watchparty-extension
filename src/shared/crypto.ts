// AES-GCM message encryption for room chat, via WebCrypto.
//
// Each room gets a random 256-bit key at creation. Messages are encrypted
// before they ever reach Firestore, so the stored documents contain ciphertext
// only — a database export or a browse through the Firebase console shows
// nothing readable.
//
// Threat model (be clear about this): the room key lives on the room document,
// so anyone your security rules allow to READ the room can also decrypt its
// chat. That means it protects message contents at rest and limits the blast
// radius of a leaked `messages` collection — it is NOT end-to-end encryption
// against your own Firebase project. See `deriveKeyFromPassphrase` for the
// stronger variant where the key is never stored.

const ALGO = 'AES-GCM';
const KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit nonce, the AES-GCM standard

export interface Ciphertext {
  iv: string; // base64
  ct: string; // base64
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Returns a plain ArrayBuffer: WebCrypto's BufferSource wants a concrete
// ArrayBuffer, and a bare Uint8Array is typed over ArrayBufferLike.
function fromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const buf = new ArrayBuffer(s.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  return buf;
}

/** Fresh random room key, base64 — stored on the room document. */
export function generateRoomKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(KEY_BITS / 8)));
}

export function importRoomKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(b64), ALGO, false, ['encrypt', 'decrypt']);
}

/**
 * Stronger option: derive the key from a passphrase that is never stored
 * anywhere. Nobody with database access can decrypt without it — but everyone
 * in the room has to be told the passphrase out of band.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  saltB64: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: 250_000, hash: 'SHA-256' },
    material,
    { name: ALGO, length: KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Random salt for passphrase derivation — safe to store publicly. */
export function generateSalt(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Known plaintext encrypted with the room key at creation. It lets a client
 * check a typed passphrase without the server ever holding the key: derive,
 * try to decrypt this, and see whether you get the sentinel back.
 */
const VERIFIER = 'watchparty-room-v1';

export function makeVerifier(key: CryptoKey): Promise<Ciphertext> {
  return encryptText(key, VERIFIER);
}

export async function checkVerifier(key: CryptoKey, v: Ciphertext | null): Promise<boolean> {
  if (!v?.iv || !v?.ct) return false;
  try {
    return (await decryptText(key, v)) === VERIFIER;
  } catch {
    // A wrong key fails GCM's auth tag — exactly what we're testing for.
    return false;
  }
}

export async function encryptText(key: CryptoKey, plaintext: string): Promise<Ciphertext> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptText(key: CryptoKey, payload: Ciphertext): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: ALGO, iv: fromB64(payload.iv) },
    key,
    fromB64(payload.ct),
  );
  return new TextDecoder().decode(plain);
}
