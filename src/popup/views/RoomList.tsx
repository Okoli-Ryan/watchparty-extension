import { useEffect, useMemo, useState } from 'react';
import { watchRooms, isRoomLive, roomsRef } from '../../firebase/rooms';
import { sendBg } from '../bg';
import { ext } from '../../shared/ext';
import type { Room, UserProfile } from '../../shared/types';

/** Open the full-page dashboard in a new tab. */
export function openDashboard() {
  void ext.tabs.create({ url: ext.runtime.getURL('src/dashboard/index.html') });
}

export function RoomList({ me: _me }: { me: UserProfile }) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompting, setPrompting] = useState<string | null>(null);
  const [passInput, setPassInput] = useState('');
  const [passError, setPassError] = useState<string | null>(null);
  // Re-evaluate liveness on a timer: a room can go stale with no Firestore
  // write to trigger a re-render.
  const [, setTick] = useState(0);

  useEffect(() => {
    const unsub = watchRooms((rs) => {
      setRooms(rs);
      setLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const live = useMemo(() => {
    const ref = roomsRef(rooms);
    return rooms.filter((r) => isRoomLive(r, ref));
  }, [rooms]);

  async function startPicker() {
    setError(null);
    setBusy(true);
    const res = await sendBg({ t: 'START_PICKER' });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    window.close();
  }

  async function join(roomId: string, passphrase?: string) {
    setError(null);
    setBusy(true);
    const res = await sendBg({ t: 'JOIN_ROOM', roomId, passphrase });
    setBusy(false);
    if (res.ok) {
      window.close();
      return;
    }
    // Private rooms answer with a sentinel instead of an error message, so the
    // list can swap in a passphrase prompt for that row.
    if (res.error === 'PASSPHRASE_REQUIRED') {
      setPrompting(roomId);
      setPassError(null);
    } else if (res.error === 'PASSPHRASE_INVALID') {
      setPrompting(roomId);
      setPassError('Incorrect passphrase.');
    } else {
      setError(res.error);
    }
  }

  return (
    <div>
      <button onClick={startPicker} disabled={busy}>
        + Create a room (pick a video)
      </button>
      {error && <div className="alert error">{error}</div>}

      <h2 style={{ marginTop: 14 }}>Active rooms ({live.length})</h2>
      {loading ? (
        <div className="empty">Loading…</div>
      ) : live.length === 0 ? (
        <div className="empty">No active rooms. Create one!</div>
      ) : (
        live.map((room) => (
          <div className="card" key={room.id}>
            <div className="room">
              <div className="meta">
                <div className="name">
                  <span className="dot live" />
                  {room.visibility === 'private' && <span title="Private room">🔒 </span>}
                  {room.name}
                </div>
                <div className="owner">
                  host: {room.ownerName} · {hostOf(room.pageUrl)}
                </div>
              </div>
              <button
                className="secondary"
                onClick={() => (prompting === room.id ? setPrompting(null) : join(room.id))}
                disabled={busy}
              >
                {prompting === room.id ? 'Cancel' : 'Join'}
              </button>
            </div>

            {prompting === room.id && (
              <form
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void join(room.id, passInput);
                }}
              >
                <input
                  type="password"
                  value={passInput}
                  onChange={(e) => setPassInput(e.target.value)}
                  placeholder="Room passphrase"
                  autoFocus
                  required
                />
                {passError && <div className="alert error">{passError}</div>}
                <button type="submit" disabled={busy}>
                  Unlock &amp; join
                </button>
              </form>
            )}
          </div>
        ))
      )}

      {/* History, favourites and settings all live on the dashboard, where
          there's room for them. */}
      <button className="secondary" style={{ marginTop: 14 }} onClick={openDashboard}>
        ⧉ Open dashboard — history &amp; favourites
      </button>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
