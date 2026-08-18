import { useEffect, useMemo, useState } from 'react';
import { watchAuth, logout } from '../firebase/auth';
import { sendBg } from '../popup/bg';
import { watchRooms, isRoomLive, roomsRef } from '../firebase/rooms';
import { watchHistory, setFavourite, removeFromHistory } from '../firebase/history';
import { HISTORY_PAGE_SIZE } from '../shared/constants';
import { formatDate, formatDateTime, timeAgo } from '../shared/dates';
import {
  getSettings,
  saveSettings,
  watchSettings,
  DEFAULT_SETTINGS,
  type Settings,
} from '../shared/settings';
import type { Room, RoomHistoryEntry, UserProfile } from '../shared/types';

type Tab = 'rooms' | 'favourites' | 'history' | 'settings';

export function Dashboard() {
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [history, setHistory] = useState<RoomHistoryEntry[]>([]);
  const [tab, setTab] = useState<Tab>('rooms');
  const [page, setPage] = useState(0);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [joining, setJoining] = useState<string | null>(null);
  const [prompting, setPrompting] = useState<string | null>(null);
  const [passInput, setPassInput] = useState('');
  const [joinError, setJoinError] = useState<Record<string, string>>({});

  /**
   * Join from the dashboard. `newTab: true` because the active tab here IS the
   * dashboard — the room needs a tab of its own.
   */
  async function join(roomId: string, passphrase?: string) {
    setJoining(roomId);
    setJoinError((e) => ({ ...e, [roomId]: '' }));
    const res = await sendBg({ t: 'JOIN_ROOM', roomId, passphrase, newTab: true });
    setJoining(null);
    if (res.ok) {
      setPrompting(null);
      setPassInput('');
      return;
    }
    if (res.error === 'PASSPHRASE_REQUIRED') {
      setPrompting(roomId);
    } else if (res.error === 'PASSPHRASE_INVALID') {
      setPrompting(roomId);
      setJoinError((e) => ({ ...e, [roomId]: 'Incorrect passphrase.' }));
    } else {
      setJoinError((e) => ({ ...e, [roomId]: res.error }));
    }
  }

  useEffect(() => {
    void getSettings().then(setSettings);
    return watchSettings(setSettings);
  }, []);

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

  // A room's live state comes from the rooms collection; history only records
  // that this user attended it.
  const liveIds = useMemo(() => new Set(live.map((r) => r.id)), [live]);
  const favourites = useMemo(() => history.filter((h) => h.favourite), [history]);

  const pageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const pageItems = history.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);

  useEffect(() => {
    // Keep the page in range when entries are removed.
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  if (profile === undefined) return <div className="dash-empty">Loading…</div>;
  if (profile === null) {
    return (
      <div className="dash-empty">
        You're signed out. Open the extension popup to sign in, then reload this page.
      </div>
    );
  }

  const toggleFav = (entry: RoomHistoryEntry) =>
    setFavourite(profile.uid, entry.roomId, !entry.favourite);

  return (
    <div>
      <div className="dash-head">
        <div>
          <h1>WatchParty Sync</h1>
          <div className="sub">
            {profile.displayName} · {profile.role} · {history.length} room
            {history.length === 1 ? '' : 's'} watched
          </div>
        </div>
        <button className="btn-signout" onClick={() => logout()}>
          Sign out
        </button>
      </div>

      <div className="dash-tabs">
        <button className={tab === 'rooms' ? 'active' : ''} onClick={() => setTab('rooms')}>
          Active ({live.length})
        </button>
        <button
          className={tab === 'favourites' ? 'active' : ''}
          onClick={() => setTab('favourites')}
        >
          ★ Favourites ({favourites.length})
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History ({history.length})
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          ⚙ Settings
        </button>
      </div>

      {tab === 'settings' && (
        <div className="dash-section">
          <h2>Settings</h2>
          <div className="rcard" style={{ maxWidth: 460 }}>
            <label className="setting">
              <input
                type="checkbox"
                checked={settings.chatBeep}
                onChange={(e) => void saveSettings({ chatBeep: e.target.checked }).then(setSettings)}
              />
              <span>
                <strong>Chat sound</strong>
                <span className="muted" style={{ display: 'block', marginTop: 3 }}>
                  Play a short tone when someone else sends a message. Applies immediately,
                  including in rooms you already have open.
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {tab === 'rooms' && (
        <div className="dash-section">
          <h2>Rooms happening now</h2>
          {live.length === 0 ? (
            <div className="dash-empty">
              No active rooms. Start one from the extension popup on a page with a video.
            </div>
          ) : (
            <div className="grid">
              {live.map((room) => (
                <div className="rcard" key={room.id}>
                  <div className="top">
                    <div style={{ minWidth: 0 }}>
                      <div className="rname">
                        {room.visibility === 'private' && '🔒 '}
                        {room.name}
                      </div>
                      <div className="rhost">
                        host: {room.ownerName} · {hostOf(room.pageUrl)}
                      </div>
                    </div>
                    <span className="badge owner">live</span>
                  </div>
                  <div className="dates">
                    <div className="dline">
                      <span className="dk">Created</span>
                      <span>{formatDate(room.createdAt?.toMillis?.())}</span>
                    </div>
                    <div className="dline">
                      <span className="dk">Last active</span>
                      <span>{timeAgo(room.lastActiveAt?.toMillis?.())}</span>
                    </div>
                  </div>

                  {joinError[room.id] && <div className="alert error">{joinError[room.id]}</div>}

                  {prompting === room.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void join(room.id, passInput);
                      }}
                    >
                      <input
                        type="password"
                        value={passInput}
                        onChange={(e) => setPassInput(e.target.value)}
                        placeholder="Room passphrase"
                        autoFocus
                        required
                      />
                      <div className="actions" style={{ marginTop: 8 }}>
                        <button type="submit" disabled={joining !== null}>
                          Unlock &amp; join
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setPrompting(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="actions">
                      <button onClick={() => join(room.id)} disabled={joining !== null}>
                        {joining === room.id ? 'Joining…' : 'Join room'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'favourites' && (
        <div className="dash-section">
          <h2>Your favourites</h2>
          {favourites.length === 0 ? (
            <div className="dash-empty">
              No favourites yet. Star a room in History to keep it here — handy for a show
              you come back to.
            </div>
          ) : (
            <div className="grid">
              {favourites.map((e) => (
                <HistoryCard
                  key={e.roomId}
                  entry={e}
                  isLive={liveIds.has(e.roomId)}
                  onToggleFav={() => toggleFav(e)}
                  onRemove={() => removeFromHistory(profile.uid, e.roomId)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="dash-section">
          <h2>Everything you've watched</h2>
          {history.length === 0 ? (
            <div className="dash-empty">Nothing here yet — join a room and it'll appear.</div>
          ) : (
            <>
              <div className="grid">
                {pageItems.map((e) => (
                  <HistoryCard
                    key={e.roomId}
                    entry={e}
                    isLive={liveIds.has(e.roomId)}
                    onToggleFav={() => toggleFav(e)}
                    onRemove={() => removeFromHistory(profile.uid, e.roomId)}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryCard({
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || 'unknown';
  }
}
