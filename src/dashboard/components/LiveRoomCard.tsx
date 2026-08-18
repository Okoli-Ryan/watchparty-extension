import { useState } from 'react';
import { formatDate, timeAgo } from '../../shared/dates';
import { hostOf } from '../../shared/url';
import type { Room } from '../../shared/types';

/**
 * One room in the "happening now" grid, with its join control.
 *
 * The passphrase input is local state rather than the tab's: only one room
 * prompts at a time, and holding it here means what you typed for one room can
 * never surface in another's form.
 */
export function LiveRoomCard({
  room,
  prompting,
  joining,
  busy,
  error,
  onJoin,
  onCancelPrompt,
}: {
  room: Room;
  /** This room needs a passphrase — show the form instead of the Join button. */
  prompting: boolean;
  /** This room's join request is in flight. */
  joining: boolean;
  /** Some join is in flight (possibly another room's), so block a second one. */
  busy: boolean;
  error?: string;
  onJoin: (passphrase?: string) => void;
  onCancelPrompt: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');

  return (
    <div className="rcard">
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="rname">
            {room.visibility === 'private' && '🔒 '}
            {room.name}
          </div>
          <div className="rhost">
            host: {room.ownerName} · {hostOf(room.pageUrl)}
          </div>
        </div>
        <span className="badge owner">live</span>
      </div>

      <div className="dates">
        <div className="dline">
          <span className="dk">Created</span>
          <span>{formatDate(room.createdAt?.toMillis?.())}</span>
        </div>
        <div className="dline">
          <span className="dk">Last active</span>
          <span>{timeAgo(room.lastActiveAt?.toMillis?.())}</span>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {prompting ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onJoin(passphrase);
          }}
        >
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Room passphrase"
            autoFocus
            required
          />
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>
              Unlock &amp; join
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPassphrase('');
                onCancelPrompt();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button onClick={() => onJoin()} disabled={busy}>
            {joining ? 'Joining…' : 'Join room'}
          </button>
        </div>
      )}
    </div>
  );
}
