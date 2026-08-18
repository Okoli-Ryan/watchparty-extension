import { useEffect, useState } from 'react';
import { watchRoom } from '../../firebase/rooms';
import { watchMembers, isFresh, freshnessRef } from '../../firebase/presence';
import { sendBg } from '../bg';
import { openDashboard } from './RoomList';
import type { Member, Room } from '../../shared/types';
import type { AttachState } from '../../shared/messages';

/**
 * In-room view for the popup. Deliberately minimal: the roster, host handover,
 * chat, reactions and "Change video" all live on the floating widget, which is
 * where you actually are while watching. Duplicating them here meant two places
 * to keep in sync for controls you'd rarely reach for from the popup.
 */
export function RoomView({ roomId, myUid, onLeave }: { roomId: string; myUid: string; onLeave: () => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [attach, setAttach] = useState<AttachState | null>(null);

  useEffect(() => watchRoom(roomId, setRoom), [roomId]);
  useEffect(() => watchMembers(roomId, setMembers), [roomId]);

  // Poll the background for the live attach role + any player error it hit.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await sendBg({ t: 'GET_ATTACH_STATE' });
      if (alive && res.ok && 'attachState' in res) setAttach(res.attachState);
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  async function leave() {
    await sendBg({ t: 'LEAVE_ROOM' });
    onLeave();
  }

  const role = attach?.role ?? (room?.ownerUid === myUid ? 'owner' : 'viewer');
  const ref = freshnessRef(members);
  const watching = members.filter((m) => isFresh(m, ref)).length;

  if (!room) {
    return (
      <div>
        <div className="empty">Room ended.</div>
        <button className="secondary" onClick={onLeave}>
          Back to rooms
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="header">
        <div style={{ minWidth: 0 }}>
          <h1 style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {room.name}
          </h1>
          <div className="sub">{room.isActive ? 'Live' : 'Ended'}</div>
        </div>
        <span className={`badge ${role}`}>{role === 'owner' ? 'host' : 'viewer'}</span>
      </div>

      {attach?.error && <div className="alert error">{attach.error}</div>}

      {role === 'owner' ? (
        <div className="alert info">You control playback. Play, pause and seek — everyone follows.</div>
      ) : (
        <div className="alert info">Following {room.ownerName}. Your player mirrors theirs.</div>
      )}

      <div className="card" style={{ marginTop: 10 }}>
        <div className="room">
          <div className="meta">
            <div className="name">
              {watching} watching · host {room.ownerName}
            </div>
            <div className="owner">{hostOf(room.pageUrl)}</div>
          </div>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 10 }}>
        Chat, reactions, {role === 'owner' ? 'changing the video and handing over the host role' : 'and syncing with the host'}{' '}
        are on the floating widget on the video page.
      </p>

      <button className="secondary" onClick={openDashboard}>
        ⧉ Open dashboard
      </button>
      <button className="danger" onClick={leave}>
        Leave room
      </button>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
