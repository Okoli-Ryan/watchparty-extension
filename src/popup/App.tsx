import { useCallback, useEffect, useState } from 'react';
import { watchAuth, logout } from '../firebase/auth';
import { sendBg } from './bg';
import type { UserProfile } from '../shared/types';
import type { PendingPick } from '../shared/messages';
import { Login } from './views/Login';
import { RoomList } from './views/RoomList';
import { CreateRoom } from './views/CreateRoom';
import { RoomView } from './views/RoomView';
import { AdminUsers } from './views/AdminUsers';

type Profile = UserProfile | null | undefined; // undefined = loading

function samePick(a: PendingPick | null, b: PendingPick | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.selector === b.selector && a.pageUrl === b.pageUrl && a.currentTime === b.currentTime;
}

export function App() {
  const [profile, setProfile] = useState<Profile>(undefined);
  const [attachRoomId, setAttachRoomId] = useState<string | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [tab, setTab] = useState<'rooms' | 'users'>('rooms');

  const refresh = useCallback(async () => {
    const [state, pick] = await Promise.all([
      sendBg({ t: 'GET_ATTACH_STATE' }),
      sendBg({ t: 'GET_PENDING_PICK' }),
    ]);
    if (state.ok && 'attachState' in state) {
      setAttachRoomId((prev) => (prev === state.attachState.roomId ? prev : state.attachState.roomId));
    }
    if (pick.ok && 'pendingPick' in pick) {
      // Keep the same object identity while the pick is unchanged so the
      // CreateRoom form (and the user's typing) isn't disturbed by polling.
      const next = pick.pendingPick;
      setPendingPick((prev) => (samePick(prev, next) ? prev : next));
    }
  }, []);

  useEffect(() => {
    const unsub = watchAuth((p) => setProfile(p));
    return unsub;
  }, []);

  useEffect(() => {
    if (!profile) return;
    void refresh();
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [profile, refresh]);

  if (profile === undefined) return <div className="empty">Loading…</div>;
  if (profile === null) return <Login />;

  // In a room → room controls take over the popup.
  if (attachRoomId) {
    return (
      <RoomView
        roomId={attachRoomId}
        myUid={profile.uid}
        onLeave={() => {
          setAttachRoomId(null);
          void refresh();
        }}
      />
    );
  }

  // A video was just picked → confirm & name the room.
  if (pendingPick) {
    return (
      <CreateRoom
        pick={pendingPick}
        me={profile}
        onDone={() => {
          setPendingPick(null);
          void refresh();
        }}
        onCancel={() => {
          setPendingPick(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div>
      <div className="header">
        <div>
          <h1>WatchParty Sync</h1>
          <div className="sub">
            {profile.displayName} · {profile.role}
          </div>
        </div>
        <button className="btn-signout" onClick={() => logout()} title="Sign out">
          Sign out
        </button>
      </div>

      {profile.role === 'admin' && (
        <div className="tabs">
          <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>
            Rooms
          </button>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            Users
          </button>
        </div>
      )}

      {tab === 'users' && profile.role === 'admin' ? <AdminUsers /> : <RoomList me={profile} />}
    </div>
  );
}
