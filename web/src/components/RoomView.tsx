import { useEffect, useMemo, useState } from 'react';
import { watchMembers, isFresh, freshnessRef } from '../../../src/firebase/presence';
import { formatDate, timeAgo } from '../../../src/shared/dates';
import { hostOf } from '../../../src/shared/url';
import type { Member, Room, UserProfile } from '../../../src/shared/types';
import { Chat } from './Chat';

/** mm:ss / h:mm:ss for a playhead position. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/**
 * One room in full: what it is playing, who is watching, and its chat.
 *
 * Note what this deliberately does NOT do — write a member document. Membership
 * means "a browser with the extension attached to this video", and it feeds
 * presence and automatic ownership handoff. A dashboard tab is neither, and
 * adding itself would inflate the watcher count and make itself a candidate to
 * inherit a room it cannot actually drive. So this observes and chats; it never
 * joins.
 */
export function RoomView({ room, me, isLive }: { room: Room; me: UserProfile; isLive: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  // Presence decays on a clock, not on writes: without a tick the watcher list
  // would freeze at its last snapshot once everyone stopped heartbeating.
  const [, setTick] = useState(0);

  useEffect(() => {
    setMembers([]);
    return watchMembers(room.id, setMembers);
  }, [room.id]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 3000);
    return () => window.clearInterval(id);
  }, []);

  const present = useMemo(() => {
    const ref = freshnessRef(members);
    return members.filter((m) => isFresh(m, ref));
  }, [members]);

  const playing = !!room.playback?.isPlaying;
  // hostPosition is refreshed on the room heartbeat; playback only moves when
  // the host acts, so prefer whichever was written more recently.
  const pbAt = room.playback?.updatedAt?.toMillis?.() ?? 0;
  const hpAt = room.hostPosition?.updatedAt?.toMillis?.() ?? 0;
  const at = hpAt > pbAt ? room.hostPosition!.currentTime : (room.playback?.currentTime ?? 0);
  const atAge = Math.max(pbAt, hpAt);

  return (
    <section className="room">
      <header className="room-head">
        <div className="room-title">
          <h2>
            {room.visibility === 'private' && '🔒 '}
            {room.name}
          </h2>
          <span className={`badge ${isLive ? 'live' : 'ended'}`}>{isLive ? 'live' : 'ended'}</span>
        </div>
        <a href={room.pageUrl} target="_blank" rel="noreferrer noopener" className="page-link">
          {hostOf(room.pageUrl)} ↗
        </a>
      </header>

      <div className="stats">
        <Stat label="Host" value={room.ownerName} />
        <Stat label="State" value={playing ? '▶ playing' : '⏸ paused'} />
        <Stat label="Position" value={clock(at)} hint={atAge ? `as of ${timeAgo(atAge)}` : undefined} />
        <Stat label="Watching" value={String(present.length)} />
        <Stat label="Created" value={formatDate(room.createdAt?.toMillis?.())} />
        <Stat label="Last active" value={timeAgo(room.lastActiveAt?.toMillis?.())} />
      </div>

      <div className="watchers">
        {present.length === 0 ? (
          <span className="muted small">Nobody is in this room right now.</span>
        ) : (
          present.map((m) => (
            <span key={m.uid} className={`chip${m.uid === room.ownerUid ? ' host' : ''}`}>
              {m.displayName}
              {m.uid === room.ownerUid && ' · host'}
            </span>
          ))
        )}
      </div>

      <Chat room={room} me={me} />
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
