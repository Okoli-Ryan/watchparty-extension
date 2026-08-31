import type { Room, RoomHistoryEntry } from '../../../src/shared/types';
import { timeAgo } from '../../../src/shared/dates';
import { hostOf } from '../../../src/shared/url';

/** Live rooms and the user's own history, as a selectable sidebar. */
export function RoomList({
  tab,
  onTab,
  live,
  history,
  liveIds,
  selectedId,
  onSelect,
}: {
  tab: 'live' | 'history';
  onTab: (t: 'live' | 'history') => void;
  live: Room[];
  history: RoomHistoryEntry[];
  liveIds: Set<string>;
  selectedId: string | null;
  onSelect: (roomId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={tab === 'live' ? 'active' : ''} onClick={() => onTab('live')}>
          Live ({live.length})
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => onTab('history')}>
          History ({history.length})
        </button>
      </div>

      <div className="list">
        {tab === 'live' &&
          (live.length === 0 ? (
            <div className="empty">
              No rooms are running. Start one from the extension on a page with a video.
            </div>
          ) : (
            live.map((room) => (
              <button
                key={room.id}
                className={`row${selectedId === room.id ? ' selected' : ''}`}
                onClick={() => onSelect(room.id)}
              >
                <div className="row-top">
                  <span className={`dot ${room.playback?.isPlaying ? 'playing' : 'paused'}`} />
                  <span className="row-name">
                    {room.visibility === 'private' && '🔒 '}
                    {room.name}
                  </span>
                </div>
                <div className="row-sub">
                  {room.ownerName} · {hostOf(room.pageUrl)}
                </div>
              </button>
            ))
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
