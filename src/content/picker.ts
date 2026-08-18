import { finder } from '@medv/finder';

// LocatorJS-style click-to-select overlay, scoped to <video> elements.

export interface PickResult {
  selector: string;
  currentTime: number;
  /** URL/origin of THIS frame — the top page URL is resolved by the background. */
  frameUrl: string;
  frameOrigin: string;
  isTop: boolean;
}

type Callbacks = {
  onPick: (result: PickResult) => void;
  onError: (reason: string) => void;
  onCancel: () => void;
};

let active = false;
let overlay: HTMLDivElement | null = null;
let highlight: HTMLDivElement | null = null;
let label: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
let current: HTMLVideoElement | null = null;
let cbs: Callbacks | null = null;

const Z = 2147483000; // sit above virtually everything

function styleEl(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

function buildUi() {
  overlay = document.createElement('div');
  styleEl(overlay, {
    position: 'fixed',
    inset: '0',
    zIndex: String(Z),
    cursor: 'crosshair',
    background: 'transparent',
  });

  highlight = document.createElement('div');
  styleEl(highlight, {
    position: 'fixed',
    pointerEvents: 'none',
    border: '2px solid #6c5ce7',
    background: 'rgba(108, 92, 231, 0.15)',
    borderRadius: '4px',
    zIndex: String(Z + 1),
    display: 'none',
    transition: 'all 60ms ease-out',
  });

  label = document.createElement('div');
  styleEl(label, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: String(Z + 2),
    padding: '4px 8px',
    borderRadius: '4px',
    background: '#6c5ce7',
    color: '#fff',
    font: '600 12px/1.2 system-ui, sans-serif',
    display: 'none',
    whiteSpace: 'nowrap',
  });

  banner = document.createElement('div');
  styleEl(banner, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: String(Z + 3),
    padding: '8px 14px',
    borderRadius: '999px',
    background: 'rgba(20,20,30,0.9)',
    color: '#fff',
    font: '500 13px/1.2 system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    pointerEvents: 'none',
  });
  banner.textContent = 'Click a video to sync it · Esc to cancel';

  document.body.append(overlay, highlight, label, banner);
}

/** Find the topmost <video> at a point, seeing through our transparent overlay. */
function videoAt(x: number, y: number): HTMLVideoElement | null {
  // Temporarily let clicks pass through the overlay so elementsFromPoint sees
  // the page, not our own overlay div.
  overlay!.style.pointerEvents = 'none';
  const stack = document.elementsFromPoint(x, y);
  overlay!.style.pointerEvents = 'auto';
  for (const el of stack) {
    if (el instanceof HTMLVideoElement) return el;
    // A poster/overlay often sits atop the <video>; check descendants too.
    const v = (el as HTMLElement).querySelector?.('video');
    if (v instanceof HTMLVideoElement) return v;
  }
  return null;
}

function paint(video: HTMLVideoElement | null) {
  current = video;
  if (!video || !highlight || !label) {
    if (highlight) highlight.style.display = 'none';
    if (label) label.style.display = 'none';
    return;
  }
  const r = video.getBoundingClientRect();
  styleEl(highlight, {
    display: 'block',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  label.textContent = `<video> ${w}×${h}`;
  styleEl(label, {
    display: 'block',
    top: `${Math.max(4, r.top - 26)}px`,
    left: `${r.left}px`,
  });
}

function onMove(e: MouseEvent) {
  if (!active) return;
  paint(videoAt(e.clientX, e.clientY));
}

function onClick(e: MouseEvent) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  const video = videoAt(e.clientX, e.clientY);
  if (!video) {
    // Clicked empty space or a non-video element — ignore, keep picking.
    return;
  }
  try {
    // A <video> living inside a cross-origin iframe never reaches this document,
    // so anything we can see here is same-document and controllable. Guard the
    // selector generation itself in case of exotic DOMs.
    const selector = finder(video, {
      root: document.body,
      timeoutMs: 1000,
    });
    // Verify the selector actually round-trips to the same node.
    if (document.querySelector(selector) !== video) {
      finish();
      cbs?.onError('Could not compute a stable selector for this video.');
      return;
    }
    const result: PickResult = {
      selector,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      frameUrl: location.href,
      frameOrigin: location.origin,
      isTop: window.top === window.self,
    };
    finish();
    cbs?.onPick(result);
  } catch (err) {
    finish();
    cbs?.onError('This video can’t be targeted (' + (err as Error).message + ').');
  }
}

function onKey(e: KeyboardEvent) {
  if (active && e.key === 'Escape') {
    finish();
    cbs?.onCancel();
  }
}

function onScrollOrResize() {
  if (active) paint(current);
}

/**
 * Does THIS frame hold a video? The content script runs in every frame, so the
 * background arms only the frames that answer yes — otherwise the top document's
 * full-page overlay would sit above the player iframe and swallow every click
 * before the player's own overlay could see it.
 */
export function hasVideo(): boolean {
  return !!document.querySelector('video');
}

export function startPicker(callbacks: Callbacks) {
  if (active) return;
  cbs = callbacks;
  // Frames without a video stay passive — the background reports the "no video
  // anywhere" case after polling every frame.
  if (!hasVideo() || !document.body) return;
  active = true;
  buildUi();
  overlay!.addEventListener('mousemove', onMove, true);
  overlay!.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);
}

/**
 * Tear the overlay down without reporting a cancellation.
 *
 * Every caller is the background telling us to stop (PICK_CANCEL, DETACH), so
 * it already knows. Firing `onCancel()` here sent a spurious PICK_ERROR that
 * cleared the action badge — including the badge just set for a pick made in
 * another frame. A user-initiated cancel still reports, from `onKey`.
 */
export function stopPicker() {
  finish();
}

function finish() {
  active = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize, true);
  overlay?.removeEventListener('mousemove', onMove, true);
  overlay?.removeEventListener('click', onClick, true);
  banner?.remove();
  overlay?.remove();
  highlight?.remove();
  label?.remove();
  overlay = highlight = label = banner = current = null;
}
