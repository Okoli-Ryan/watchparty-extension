import { useEffect, useState } from 'react';
import { watchRoom } from '../../src/firebase/rooms';
import type { Room } from '../../src/shared/types';

/**
 * Subscribe to one room document by id, independently of the paginated list.
 *
 * The sidebar loads only the newest ROOM_PAGE_SIZE rooms, so a room opened from
 * History is easily not among them — and picking the selection out of that array
 * meant such a room rendered as "no longer available" even though it existed and
 * its chat was perfectly readable. Watching the document directly makes any room
 * the user has ever attended openable, and chattable, however old it is and
 * whether or not it is still live.
 */
export function useRoom(roomId: string | null): { room: Room | null; loading: boolean } {
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setRoom(null);
    if (!roomId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    return watchRoom(roomId, (r) => {
      setRoom(r);
      setLoading(false);
    });
  }, [roomId]);

  return { room, loading };
}
