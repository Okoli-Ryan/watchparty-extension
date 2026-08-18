import { useEffect, useMemo, useState } from 'react';
import { watchAuth } from '../firebase/auth';
import { watchRooms, isRoomLive, roomsRef } from '../firebase/rooms';
import { watchHistory } from '../firebase/history';
import type { Room, RoomHistoryEntry, UserProfile } from '../shared/types';

// The data every dashboard tab draws from, in one place. Keeping the
// subscriptions here means the tab components stay presentational and the shell
// doesn't have to thread four useEffects through its render.

export interface DashboardData {
  /** `undefined` while auth is still resolving; `null` once known signed out. */
  profile: UserProfile | null | undefined;
  /** Rooms happening right now. */
  live: Room[];
  /**
   * Ids of the live rooms. A history entry only records that this user attended
   * a room, so "live now" has to come from the rooms collection.
   */
  liveIds: Set<string>;
  history: RoomHistoryEntry[];
  favourites: RoomHistoryEntry[];
}

export function useDashboardData(): DashboardData {
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [history, setHistory] = useState<RoomHistoryEntry[]>([]);

  useEffect(() => watchAuth((p) => setProfile(p)), []);
  useEffect(() => watchRooms(setRooms), []);
  useEffect(() => {
    if (!profile) return;
    return watchHistory(profile.uid, setHistory);
  }, [profile]);

  const live = useMemo(() => {
    const ref = roomsRef(rooms);
    return rooms.filter((r) => isRoomLive(r, ref));
  }, [rooms]);

  const liveIds = useMemo(() => new Set(live.map((r) => r.id)), [live]);
  const favourites = useMemo(() => history.filter((h) => h.favourite), [history]);

  return { profile, live, liveIds, history, favourites };
}
