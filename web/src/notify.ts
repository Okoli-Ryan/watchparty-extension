import { beep } from '../../src/shared/beep';

// Incoming-message alerting for the dashboard: a sound, and an unread count in
// the tab title so a backgrounded tab still tells you something happened.

const MUTE_KEY = 'watchparty:web:muted';

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false; // storage blocked — default to audible
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* the preference just won't persist */
  }
}

// Captured before anything else edits it, so restoring is exact.
const BASE_TITLE = document.title;
let unseen = 0;

function paintTitle() {
  document.title = unseen > 0 ? `(${unseen}) ${BASE_TITLE}` : BASE_TITLE;
}

/**
 * A batch of messages arrived from someone else.
 *
 * The title badge only counts while the tab is hidden — messages that land
 * while you are looking at them are not unread, and a counter ticking up in
 * front of you is just noise.
 */
export function notifyMessages(count: number): void {
  if (count <= 0) return;
  if (!isMuted()) beep();
  if (document.hidden) {
    unseen += count;
    paintTitle();
  }
}

export function clearUnreadBadge(): void {
  if (unseen === 0) return;
  unseen = 0;
  paintTitle();
}

// Coming back to the tab is what marks them seen.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clearUnreadBadge();
});
window.addEventListener('focus', clearUnreadBadge);
