import { useMemo } from 'react';
import type { Room, RoomHistoryEntry } from '../../../src/shared/types';
import { timeAgo } from '../../../src/shared/dates';
import { hostOf } from '../../../src/shared/url';

/**
 * Rooms and history, as a selectable sidebar.
 *
 * Every recent room is listed, live or ended, with its status shown rather than
 * used as a filter. Hiding ended rooms meant one bad liveness verdict emptied
 * the whole panel and left no way to reach a room at all — and chat in an ended
 * room is still perfectly readable and writable, so there was never a reason to
 * withhold it.
 */
export function RoomList({
  tab,
  onTab,
  rooms,
  history,
  liveIds,
  selectedId,
  onSelect,
  error,
}: {
  tab: 'rooms' | 'history';
  onTab: (t: 'rooms' | 'history') => void;
  rooms: Room[];
  history: RoomHistoryEntry[];
  liveIds: Set<string>;
  selectedId: string | null;
  onSelect: (roomId: string) => void;
  error: string | null;
}) {
  // Live first, then the rest in the order they arrived (newest created first).
  const ordered = useMemo(() => {
    const live = rooms.filter((r) => liveIds.has(r.id));
    const rest = rooms.filter((r) => !liveIds.has(r.id));
    return [...live, ...rest];
  }, [rooms, liveIds]);

  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={tab === 'rooms' ? 'active' : ''} onClick={() => onTab('rooms')}>
          Rooms ({liveIds.size} live)
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => onTab('history')}>
          History ({history.length})
        </button>
      </div>

      {error && <div className="alert error side">{error}</div>}

      <div className="list">
        {tab === 'rooms' &&
          (ordered.length === 0 ? (
            <div className="empty">
              No rooms found. Create one from the extension on a page with a video.
            </div>
          ) : (
            ordered.map((room) => {
              const live = liveIds.has(room.id);
              return (
                <button
                  key={room.id}
                  className={`row${selectedId === room.id ? ' selected' : ''}`}
                  onClick={() => onSelect(room.id)}
                >
                  <div className="row-top">
                    <span
                      className={`dot ${
                        !live ? 'off' : room.playback?.isPlaying ? 'playing' : 'paused'
                      }`}
                    />
                    <span className="row-name">
                      {room.visibility === 'private' && '🔒 '}
                      {room.name}
                    </span>
                  </div>
                  <div className="row-sub">
                    {live ? `${room.ownerName} · ${hostOf(room.pageUrl)}` : 'ended'}
                  </div>
                </button>
              );
            })
          ))}

        {tab === 'history' &&
          (history.length === 0 ? (
            <div className="empty">Nothing yet — rooms you join will appear here.</div>
          ) : (
            history.map((h) => (
              <button
                key={h.roomId}
                className={`row${selectedId === h.roomId ? ' selected' : ''}`}
                onClick={() => onSelect(h.roomId)}
              >
                <div className="row-top">
                  <span className={`dot ${liveIds.has(h.roomId) ? 'playing' : 'off'}`} />
                  <span className="row-name">
                    {h.favourite && '★ '}
                    {h.roomName}
                  </span>
                </div>
                <div className="row-sub">
                  {liveIds.has(h.roomId) ? 'live now' : `watched ${timeAgo(h.lastAttendedAt)}`}
                </div>
              </button>
            ))
          ))}
      </div>
    </aside>
  );
}
