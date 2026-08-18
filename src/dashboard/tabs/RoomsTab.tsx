import { useState } from 'react';
import { sendBg } from '../../popup/bg';
import { LiveRoomCard } from '../components/LiveRoomCard';
import type { Room } from '../../shared/types';

/** Rooms happening now, and the flow for joining one. */
export function RoomsTab({ live }: { live: Room[] }) {
  const [joining, setJoining] = useState<string | null>(null);
  const [prompting, setPrompting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * `newTab: true` because the active tab here IS the dashboard — the room
   * needs a tab of its own rather than navigating this page away.
   */
  async function join(roomId: string, passphrase?: string) {
    setJoining(roomId);
    setErrors((e) => ({ ...e, [roomId]: '' }));
    const res = await sendBg({ t: 'JOIN_ROOM', roomId, passphrase, newTab: true });
    setJoining(null);
    if (res.ok) {
      setPrompting(null);
      return;
    }
    // Private rooms answer with a sentinel rather than a message, so the card
    // can swap in a passphrase form instead of showing an error.
    if (res.error === 'PASSPHRASE_REQUIRED') {
      setPrompting(roomId);
    } else if (res.error === 'PASSPHRASE_INVALID') {
      setPrompting(roomId);
      setErrors((e) => ({ ...e, [roomId]: 'Incorrect passphrase.' }));
    } else {
      setErrors((e) => ({ ...e, [roomId]: res.error }));
    }
  }

  return (
    <div className="dash-section">
      <h2>Rooms happening now</h2>
      {live.length === 0 ? (
        <div className="dash-empty">
          No active rooms. Start one from the extension popup on a page with a video.
        </div>
      ) : (
        <div className="grid">
          {live.map((room) => (
            <LiveRoomCard
              key={room.id}
              room={room}
              prompting={prompting === room.id}
              joining={joining === room.id}
              busy={joining !== null}
              error={errors[room.id] || undefined}
              onJoin={(passphrase) => void join(room.id, passphrase)}
              onCancelPrompt={() => setPrompting(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
