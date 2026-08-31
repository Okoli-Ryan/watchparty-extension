import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { watchMessages, sendMessage } from '../../../src/firebase/chat';
import { CHAT_MAX_LEN } from '../../../src/shared/constants';
import type { ChatMessage, Room, UserProfile } from '../../../src/shared/types';
import { resolveRoomKey, rememberPassphrase, recallPassphrase, type KeyState } from '../roomKey';

/**
 * Live transcript for one room, plus a composer.
 *
 * Messages are AES-GCM ciphertext in Firestore: they are decrypted here and
 * encrypted before they are sent, exactly as the extension's background does,
 * using the same `src/shared/crypto.ts`.
 */
export function Chat({ room, me }: { room: Room; me: UserProfile }) {
  const [keyState, setKeyState] = useState<KeyState>({ status: 'locked' });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Resolve the key whenever the room changes. A remembered passphrase is tried
  // first so switching back to a private room doesn't prompt again.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError(null);
    setPass('');
    void resolveRoomKey(room, recallPassphrase(room.id)).then((s) => {
      if (alive) setKeyState(s);
    });
    return () => {
      alive = false;
    };
  }, [room.id, room.visibility, room.chatKey, room.chatSalt]);

  // Subscribe once we hold a key.
  useEffect(() => {
    if (keyState.status !== 'ready') return;
    return watchMessages(
      room.id,
      keyState.key,
      setMessages,
      () => setError('Cannot read chat — check that firestore.rules is deployed.'),
    );
  }, [room.id, keyState]);

  // Pin to the newest message unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    const state = await resolveRoomKey(room, pass);
    setKeyState(state);
    if (state.status === 'ready') rememberPassphrase(room.id, pass.trim());
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || keyState.status !== 'ready') return;
    setSending(true);
    setDraft('');
    try {
      await sendMessage(room.id, keyState.key, me, text.slice(0, CHAT_MAX_LEN));
    } catch {
      setError('Could not send that message.');
      setDraft(text); // hand it back rather than losing what was typed
    } finally {
      setSending(false);
    }
  }

  if (keyState.status === 'none') {
    return (
      <div className="chat">
        <div className="empty">
          This room was created before chat existed, so it has no key. Nothing to show.
        </div>
      </div>
    );
  }

  if (keyState.status !== 'ready') {
    return (
      <div className="chat">
        <form className="unlock" onSubmit={unlock}>
          <div className="lock-title">🔒 Private room</div>
          <p className="muted small">
            The key is derived from the room's passphrase and is never stored anywhere, so
            it has to be entered here. Nobody — including the project owner — can read this
            chat without it.
          </p>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Room passphrase"
            autoFocus
            required
          />
          {keyState.status === 'wrong' && <div className="alert error">Incorrect passphrase.</div>}
          <button type="submit">Unlock chat</button>
        </form>
      </div>
    );
  }

  return (
    <div className="chat">
      {error && <div className="alert error">{error}</div>}
      <div className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty">No messages yet — say hello 👋</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`msg${m.senderUid === me.uid ? ' mine' : ''}`}>
              <div className="msg-head">
                <span className="who">{m.senderName}</span>
                <span className="at">{new Date(m.at).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}</span>
              </div>
              <div className="body">{m.text}</div>
            </div>
          ))
        )}
      </div>
      <form className="composer" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          maxLength={CHAT_MAX_LEN}
          autoComplete="off"
        />
        <button type="submit" disabled={sending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
