import { useEffect, useMemo, useState } from 'react';
import { watchAuth, logout } from '../../src/firebase/auth';
import { watchRooms, isRoomLive, roomsRef } from '../../src/firebase/rooms';
import { watchHistory } from '../../src/firebase/history';
import type { Room, RoomHistoryEntry, UserProfile } from '../../src/shared/types';
import { Login } from './components/Login';
import { RoomList } from './components/RoomList';
import { RoomView } from './components/RoomView';

// Companion dashboard for the extension: follow rooms and keep chatting from a
// normal browser tab. It reads the same Firestore project the extension writes
// to, so nothing here needs a server of its own.

export function App() {
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [history, setHistory] = useState<RoomHistoryEntry[]>([]);
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Liveness is derived from a heartbeat age, so it has to be re-evaluated on a
  // timer — a room going stale produces no Firestore write to re-render on.
  const [, setTick] = useState(0);

  useEffect(() => watchAuth((p) => setProfile(p)), []);
  useEffect(() => watchRooms(setRooms), []);
  useEffect(() => {
    if (!profile) return;
    return watchHistory(profile.uid, setHistory);
  }, [profile]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const live = useMemo(() => {
    const ref = roomsRef(rooms);
    return rooms.filter((r) => isRoomLive(r, ref));
  }, [rooms]);
  const liveIds = useMemo(() => new Set(live.map((r) => r.id)), [live]);
  const selected = useMemo(
    () => rooms.find((r) => r.id === selectedId) ?? null,
    [rooms, selectedId],
  );

  // Land on something useful instead of an empty pane.
  useEffect(() => {
    if (!selectedId && live.length > 0) setSelectedId(live[0].id);
  }, [live, selectedId]);

  if (profile === undefined) return <div className="boot">Loading…</div>;
  if (profile === null) return <Login />;

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <strong>WatchParty Sync</strong>
          <span className="muted"> · {profile.displayName}</span>
        </div>
        <button className="ghost" onClick={() => logout()}>
          Sign out
        </button>
      </header>

      <div className="body">
        <RoomList
          tab={tab}
          onTab={setTab}
          live={live}
          history={history}
          liveIds={liveIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <main className="main">
          {selected ? (
            <RoomView room={selected} me={profile} isLive={liveIds.has(selected.id)} />
          ) : (
            <div className="empty pad">
              {selectedId
                ? // History keeps a room after the room document itself is gone,
                  // and `watchRooms` only loads the most recent page of rooms.
                  'That room is no longer available.'
                : 'Select a room to see its activity and chat.'}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
