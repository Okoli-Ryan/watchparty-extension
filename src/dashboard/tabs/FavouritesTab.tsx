import { setFavourite, removeFromHistory } from '../../firebase/history';
import { HistoryCard } from '../components/HistoryCard';
import type { RoomHistoryEntry } from '../../shared/types';

/** The starred subset of this user's history. */
export function FavouritesTab({
  uid,
  favourites,
  liveIds,
}: {
  uid: string;
  favourites: RoomHistoryEntry[];
  liveIds: Set<string>;
}) {
  return (
    <div className="dash-section">
      <h2>Your favourites</h2>
      {favourites.length === 0 ? (
        <div className="dash-empty">
          No favourites yet. Star a room in History to keep it here — handy for a show you
          come back to.
        </div>
      ) : (
        <div className="grid">
          {favourites.map((e) => (
            <HistoryCard
              key={e.roomId}
              entry={e}
              isLive={liveIds.has(e.roomId)}
              onToggleFav={() => void setFavourite(uid, e.roomId, !e.favourite)}
              onRemove={() => void removeFromHistory(uid, e.roomId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
