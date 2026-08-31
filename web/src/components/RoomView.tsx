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
 * One room in full.
 *
 * Chat is the primary column and owns the full height; the room's details sit in
 * a narrow rail beside it. They used to stack above the transcript, which meant
 * six stat cards and a watcher list pushed the messages — the thing you actually
 * came to read — into whatever vertical space was left over.
 *
 * Note what this deliberately does NOT do: write a member document. Membership
 * means "a browser with the extension attached to this video", and it feeds
 * presence and automatic ownership handoff. A dashboard tab is neither, and
 * adding itself would inflate the watcher count and make itself a candidate to
 * inherit a room it cannot actually drive. So this observes and chats; it never
 * joins.
 */
export function RoomView({
  room,
  me,
  isLive,
  onBack,
}: {
  room: Room;
  me: UserProfile;
  isLive: boolean;
  /** Return to the list. Only reachable in the mobile master/detail layout. */
  onBack: () => void;
}) {
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
          <button className="back" onClick={onBack} aria-label="Back to rooms">
            ‹
          </button>
          <span className={`dot ${!isLive ? 'off' : playing ? 'playing' : 'paused'}`} />
          <h2>
            {room.visibility === 'private' && '🔒 '}
            {room.name}
          </h2>
          <span className={`badge ${isLive ? 'live' : 'ended'}`}>{isLive ? 'live' : 'ended'}</span>
        </div>
        <div className="head-meta">
          {isLive && (
            <span className="head-stat">
              {playing ? '▶ playing' : '⏸ paused'} · {clock(at)}
            </span>
          )}
          <a href={room.pageUrl} target="_blank" rel="noreferrer noopener" className="page-link">
            {hostOf(room.pageUrl)} ↗
          </a>
        </div>
      </header>

      <div className="room-body">
        <Chat room={room} me={me} />

        <aside className="rail">
          {!isLive && (
            <div className="note">
              This room has ended — nobody is watching and playback can't be controlled. Its
              chat is still here, and you can keep posting to it.
            </div>
          )}

          <div className="rail-block">
            <h3>Watching {isLive && <span className="count">{present.length}</span>}</h3>
            {present.length === 0 ? (
              <p className="muted small">Nobody is in this room right now.</p>
            ) : (
              <div className="watchers">
                {present.map((m) => (
                  <span key={m.uid} className={`chip${m.uid === room.ownerUid ? ' host' : ''}`}>
                    {m.displayName}
                    {m.uid === room.ownerUid && ' · host'}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="rail-block">
            <h3>Details</h3>
            <Row label="Host" value={room.ownerName} />
            <Row label="State" value={playing ? 'playing' : 'paused'} />
            <Row
              label="Position"
              value={clock(at)}
              hint={atAge ? `as of ${timeAgo(atAge)}` : undefined}
            />
            <Row label="Visibility" value={room.visibility} />
            <Row label="Created" value={formatDate(room.createdAt?.toMillis?.())} />
            <Row label="Last active" value={timeAgo(room.lastActiveAt?.toMillis?.())} />
          </div>
        </aside>
      </div>
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rail-row">
      <span className="k">{label}</span>
      <span className="v">
        {value}
        {hint && <span className="hint">{hint}</span>}
      </span>
    </div>
  );
}
