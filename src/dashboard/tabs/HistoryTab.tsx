import { useEffect, useState } from 'react';
import { setFavourite, removeFromHistory } from '../../firebase/history';
import { HISTORY_PAGE_SIZE } from '../../shared/constants';
import { HistoryCard } from '../components/HistoryCard';
import type { RoomHistoryEntry } from '../../shared/types';

/** Every room this user has attended, paginated. */
export function HistoryTab({
  uid,
  history,
  liveIds,
}: {
  uid: string;
  history: RoomHistoryEntry[];
  liveIds: Set<string>;
}) {
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const pageItems = history.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);

  useEffect(() => {
    // Keep the page in range when entries are removed.
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  if (history.length === 0) {
    return (
      <div className="dash-section">
        <h2>Everything you've watched</h2>
        <div className="dash-empty">Nothing here yet — join a room and it'll appear.</div>
      </div>
    );
  }

  return (
    <div className="dash-section">
      <h2>Everything you've watched</h2>
      <div className="grid">
        {pageItems.map((e) => (
          <HistoryCard
            key={e.roomId}
            entry={e}
            isLive={liveIds.has(e.roomId)}
            onToggleFav={() => void setFavourite(uid, e.roomId, !e.favourite)}
            onRemove={() => void removeFromHistory(uid, e.roomId)}
          />
        ))}
      </div>
      {pageCount > 1 && (
        <div className="pager">
          <button
            className="secondary"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← Previous
          </button>
          <span className="page-info">
            Page {page + 1} of {pageCount}
          </span>
          <button
            className="secondary"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
