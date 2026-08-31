import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { watchMessages, sendMessage } from '../../../src/firebase/chat';
import { CHAT_MAX_LEN } from '../../../src/shared/constants';
import type { ChatMessage, Room, UserProfile } from '../../../src/shared/types';
import { resolveRoomKey, rememberPassphrase, recallPassphrase, type KeyState } from '../roomKey';
import { notifyMessages } from '../notify';

/** "Today" / "Yesterday" / "12 Aug 2026" for a day separator. */
function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Consecutive messages from one person inside this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

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
  const [pendingBelow, setPendingBelow] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** null until the first batch lands, so the backfill never alerts. */
  const seenIds = useRef<Set<string> | null>(null);

  // Resolve the key whenever the room changes. A remembered passphrase is tried
  // first so switching back to a private room doesn't prompt again.
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError(null);
    setPass('');
    setPendingBelow(0);
    seenIds.current = null;
    atBottomRef.current = true;
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
      (next) => {
        const previous = seenIds.current;
        if (previous) {
          const fresh = next.filter((m) => !previous.has(m.id) && m.senderUid !== me.uid);
          notifyMessages(fresh.length);
          // Only badge messages the reader cannot currently see.
          if (fresh.length > 0 && !atBottomRef.current) {
            setPendingBelow((n) => n + fresh.length);
          }
        }
        seenIds.current = new Set(next.map((m) => m.id));
        setMessages(next);
      },
      () => setError('Cannot read chat — check that firestore.rules is deployed.'),
    );
  }, [room.id, keyState, me.uid]);

  // Pin to the newest message unless the reader has scrolled up to read back.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottomRef.current) setPendingBelow(0);
  }, []);

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setPendingBelow(0);
  };

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
    atBottomRef.current = true; // sending always jumps you to your own message
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
            The key is derived from the room's passphrase and is never stored anywhere, so it
            has to be entered here. Nobody — including the project owner — can read this chat
            without it.
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
      {error && <div className="alert error side">{error}</div>}

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="empty">No messages yet — say hello 👋</div>
        ) : (
          messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            const newDay = !prev || dayLabel(prev.at) !== dayLabel(m.at);
            // A run of messages from one person reads as one block; repeating
            // the name on every line turns a long transcript into noise.
            const startsGroup =
              newDay || !prev || prev.senderUid !== m.senderUid || m.at - prev.at > GROUP_WINDOW_MS;
            const mine = m.senderUid === me.uid;
            return (
              <div key={m.id}>
                {newDay && (
                  <div className="day">
                    <span>{dayLabel(m.at)}</span>
                  </div>
                )}
                <div className={`msg${mine ? ' mine' : ''}${startsGroup ? ' lead' : ''}`}>
                  {startsGroup && (
                    <div className="msg-head">
                      <span className="who">{mine ? 'You' : m.senderName}</span>
                      <span className="at">{clockTime(m.at)}</span>
                    </div>
                  )}
                  <div className="body" title={clockTime(m.at)}>
                    {m.text}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {pendingBelow > 0 && (
        <button className="jump" onClick={jumpToLatest}>
          {pendingBelow} new message{pendingBelow === 1 ? '' : 's'} ↓
        </button>
      )}

      <form className="composer" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${room.name}…`}
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
