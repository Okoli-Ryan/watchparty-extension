import { useState } from 'react';
import { createRoom } from '../../firebase/rooms';
import { sendBg } from '../bg';
import type { PendingPick } from '../../shared/messages';
import type { UserProfile, RoomVisibility } from '../../shared/types';

export function CreateRoom({
  pick,
  me,
  onDone,
  onCancel,
}: {
  pick: PendingPick;
  me: UserProfile;
  onDone: () => void;
  onCancel: () => void;
}) {
  // Initialise once from the page title; polling in App must not clobber typing.
  const [name, setName] = useState(pick.pageTitle || '');
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (visibility === 'private' && passphrase.trim().length < 4) {
        throw new Error('Choose a passphrase of at least 4 characters.');
      }
      const roomId = await createRoom({
        name,
        pageUrl: pick.pageUrl,
        selector: pick.selector,
        frameOrigin: pick.frameOrigin,
        currentTime: pick.currentTime,
        owner: me,
        visibility,
        passphrase,
      });
      const res = await sendBg({
        t: 'CREATE_ROOM_ATTACH',
        roomId,
        passphrase: visibility === 'private' ? passphrase : undefined,
      });
      if (!res.ok) throw new Error(res.error);
      onDone();
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not create the room.');
      setBusy(false);
    }
  }

  async function cancel() {
    await sendBg({ t: 'CLEAR_PENDING_PICK' });
    onCancel();
  }

  return (
    <div>
      <div className="header">
        <div>
          <h1>New room</h1>
          <div className="sub">Confirm & name your watch party</div>
        </div>
      </div>

      <div className="alert info">🎬 Video selected on this page</div>

      <form onSubmit={save}>
        <label htmlFor="room-name">Room name (video title)</label>
        <input
          id="room-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Friday Movie Night"
          required
          autoFocus
        />

        <label htmlFor="room-vis">Visibility</label>
        <select
          id="room-vis"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as RoomVisibility)}
        >
          <option value="public">Public — anyone signed in can join</option>
          <option value="private">Private — passphrase required</option>
        </select>

        {visibility === 'private' && (
          <>
            <label htmlFor="room-pass">Passphrase</label>
            <input
              id="room-pass"
              type="text"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Share this with your guests"
              minLength={4}
              required
            />
            <div className="alert info" style={{ marginTop: 8 }}>
              🔐 Chat is encrypted with this passphrase. It is never stored —
              if it's lost, the messages can't be recovered by anyone.
            </div>
          </>
        )}

        <div className="card" style={{ marginTop: 12 }}>
          <div className="muted">Page</div>
          <div className="mono">{pick.pageUrl}</div>
          <div className="muted" style={{ marginTop: 6 }}>Video selector</div>
          <div className="mono">{pick.selector}</div>
          {pick.frameOrigin && (
            <>
              <div className="muted" style={{ marginTop: 6 }}>Embedded player</div>
              <div className="mono">{pick.frameOrigin}</div>
            </>
          )}
          <div className="muted" style={{ marginTop: 6 }}>
            Start time: {formatTime(pick.currentTime)}
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create & host room'}
        </button>
        <button type="button" className="secondary" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </form>
    </div>
  );
}

function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
