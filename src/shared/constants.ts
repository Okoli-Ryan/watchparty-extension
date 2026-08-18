/** How often each room member writes its `lastSeen` heartbeat (ms). */
export const HEARTBEAT_MS = 3000;

/**
 * A member is considered gone if its heartbeat falls this far behind the
 * freshest heartbeat in the room (ms). Measured server-time vs server-time, so
 * it's ~3 missed beats of grace and immune to client clock skew.
 */
export const STALE_MS = 10000;

/**
 * How often the owner stamps `rooms/{id}.lastActiveAt`. This is what makes a
 * room's liveness self-expiring: if every client vanishes (crash, closed
 * browser) nobody needs to write `isActive:false` for the room to fall out of
 * the active list.
 */
export const ROOM_TOUCH_MS = 9000;

/** A room with no heartbeat this recent is treated as ended. */
export const ROOM_STALE_MS = 30000;

/** How many rooms to load for the list + history view. */
export const ROOM_PAGE_SIZE = 50;

/**
 * Sync is event-driven: a viewer only realigns when the host actually does
 * something (play / pause / seek / rate change, or the on-demand publish when
 * someone joins). Between events the viewer plays freely — small drift from
 * buffering is left alone rather than corrected, which would cause visible
 * stutter for no real benefit.
 *
 * This is the tolerance applied at those moments: only re-seek when the gap
 * exceeds it, so ordinary network latency doesn't produce a needless jump.
 */
export const DRIFT_THRESHOLD = 2.0;

/** How long to keep retrying to find the video element before giving up (ms). */
export const ELEMENT_WAIT_MS = 10000;

/** How many recent chat messages to keep loaded per room. */
export const CHAT_PAGE_SIZE = 100;

/** Max characters accepted in a single chat message. */
export const CHAT_MAX_LEN = 500;

/** Rooms shown in the popup's collapsed History list before "View all". */
export const HISTORY_PREVIEW = 10;

/** Rooms per page in the dashboard's paginated history. */
export const HISTORY_PAGE_SIZE = 20;

export const COLLECTIONS = {
  users: 'users',
  rooms: 'rooms',
  members: 'members',
  messages: 'messages',
  history: 'history',
} as const;
