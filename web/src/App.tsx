import { useEffect, useMemo, useState } from 'react';
import { watchAuth, logout } from '../../src/firebase/auth';
import { watchRooms, isRoomLive, roomsRef } from '../../src/firebase/rooms';
import { watchHistory } from '../../src/firebase/history';
import type { Room, RoomHistoryEntry, UserProfile } from '../../src/shared/types';
import { Login } from './components/Login';
import { RoomList } from './components/RoomList';
import { RoomView } from './components/RoomView';
import { useRoom } from './useRoom';
import { isMuted, setMuted as persistMuted } from './notify';
import { useResubscribe } from './useResubscribe';

// Companion dashboard for the extension: follow rooms and keep chatting from a
// normal browser tab. It reads the same Firestore project the extension writes
// to, so nothing here needs a server of its own.

export function App() {
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [history, setHistory] = useState<RoomHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(isMuted);
  const { nonce, retry } = useResubscribe();
  const [tab, setTab] = useState<'rooms' | 'history'>('rooms');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Liveness decays on a clock rather than on writes, so re-render periodically
  // — a room going stale produces no snapshot to re-render on.
  const [, setTick] = useState(0);

  useEffect(() => watchAuth((p) => setProfile(p)), []);

  // Subscribe only once signed in. Firestore rules require auth to read rooms,
  // and a listener that errors is never retried — subscribing too early would
  // leave an empty list for the whole session.
  useEffect(() => {
    if (!profile) return;
    setError(null);
    return watchRooms(setRooms, (err) => {
      setError(
        err.message.includes('permission')
          ? 'Cannot read rooms — check that firestore.rules is deployed.'
          : 'Lost connection to the room list — reconnecting…',
      );
      // onSnapshot never retries after an error; without this the list is stale
      // for the rest of the session.
      setTimeout(retry, 3000);
    });
  }, [profile, nonce, retry]);

  useEffect(() => {
    if (!profile) return;
    return watchHistory(profile.uid, setHistory);
  }, [profile]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const liveIds = useMemo(() => {
    const ref = roomsRef(rooms);
    return new Set(rooms.filter((r) => isRoomLive(r, ref)).map((r) => r.id));
  }, [rooms]);

  // The selection is watched directly rather than looked up in `rooms`: the list
  // holds only the newest page, so a room opened from History may not be in it.
  const { room: selected, loading } = useRoom(selectedId);

  // Land on something useful rather than an empty pane — but only where both
  // panes are visible at once. On a phone the layout is master/detail, so
  // auto-selecting would drop the user into a room before they chose one.
  useEffect(() => {
    if (selectedId || rooms.length === 0) return;
    if (!window.matchMedia('(min-width: 721px)').matches) return;
    const firstLive = rooms.find((r) => liveIds.has(r.id));
    setSelectedId((firstLive ?? rooms[0]).id);
  }, [rooms, liveIds, selectedId]);

  if (profile === undefined) return <div className="boot">Loading…</div>;
  if (profile === null) return <Login />;

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <strong>WatchParty Sync</strong>
          <span className="muted"> · {profile.displayName}</span>
        </div>
        <div className="head-actions">
          <button
            className={`icon-btn${muted ? '' : ' on'}`}
            onClick={() => {
              const next = !muted;
              setMuted(next);
              persistMuted(next);
            }}
            title={muted ? 'Message sound off' : 'Message sound on'}
            aria-label={muted ? 'Unmute message sound' : 'Mute message sound'}
          >
            {muted ? '🔇' : '🔔'}
          </button>
          <button className="ghost" onClick={() => logout()}>
            Sign out
          </button>
        </div>
      </header>

      <div className={`body${selectedId ? ' has-selection' : ''}`}>
        <RoomList
          tab={tab}
          onTab={setTab}
          rooms={rooms}
          history={history}
          liveIds={liveIds}
          selectedId={selectedId}
          onSelect={setSelectedId}
          error={error}
        />
        <main className="main">
          {selected ? (
            <RoomView
              room={selected}
              me={profile}
              isLive={liveIds.has(selected.id)}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <div className="empty pad">
              {!selectedId
                ? 'Select a room to see its activity and chat.'
                : loading
                  ? 'Opening room…'
                  : 'That room has been deleted.'}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
