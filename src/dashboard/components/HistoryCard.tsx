import { formatDate, formatDateTime } from '../../shared/dates';
import { hostOf } from '../../shared/url';
import type { RoomHistoryEntry } from '../../shared/types';

/** One room this user has attended. Shared by the Favourites and History tabs. */
export function HistoryCard({
  entry,
  isLive,
  onToggleFav,
  onRemove,
}: {
  entry: RoomHistoryEntry;
  isLive: boolean;
  onToggleFav: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="rcard">
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="rname">{entry.roomName}</div>
          <div className="rhost">{hostOf(entry.pageUrl)}</div>
        </div>
        <button
          className="star"
          onClick={onToggleFav}
          title={entry.favourite ? 'Remove from favourites' : 'Add to favourites'}
        >
          {entry.favourite ? '★' : '☆'}
        </button>
      </div>

      <div className="dates">
        <div className="dline">
          <span className="dk">Room created</span>
          <span>{formatDate(entry.roomCreatedAt)}</span>
        </div>
        <div className="dline">
          <span className="dk">You last watched</span>
          <span>{formatDateTime(entry.lastAttendedAt)}</span>
        </div>
      </div>

      <div className="actions">
        {isLive ? (
          <span className="badge owner" style={{ alignSelf: 'center' }}>
            live now
          </span>
        ) : (
          <a
            href={entry.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="muted"
            style={{ fontSize: 12, alignSelf: 'center' }}
          >
            Open page ↗
          </a>
        )}
        <button className="secondary" onClick={onRemove} title="Remove from your history">
          Remove
        </button>
      </div>
    </div>
  );
}
