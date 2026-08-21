import { finder } from '@medv/finder';
import { rankedVideos, type VideoCandidate } from './videoScan';

// Keyboard-driven video picker.
//
// The user steps through the page's videos with the arrow keys — ordered most-
// likely-first by `rankedVideos()` — and confirms with Enter. The candidate in
// focus wears the highlight overlay.
//
// WHY NOT CLICK-TO-SELECT (what this replaced): selecting by click needed a
// transparent full-viewport overlay to catch the mouse, and that overlay sat
// above embedded players and swallowed their clicks. Streaming sites put the
// real player in a cross-origin iframe, so the top document's overlay was
// covering exactly the thing you wanted to click. Keyboard selection needs no
// click target at all, so every element here is `pointer-events: none` and the
// page underneath stays completely interactive.
//
// FRAMES: this script runs in every frame, and each frame can only see its own
// videos and only receives key events when it holds focus. So no frame can own
// the selection. Each reports its candidates to the background, which merges
// them into one ranked list and drives the highlight; every armed frame forwards
// key presses. The banner renders in the top frame only, like the widget.

export interface PickResult {
  selector: string;
  currentTime: number;
  /** URL/origin of THIS frame — the top page URL is resolved by the background. */
  frameUrl: string;
  frameOrigin: string;
  isTop: boolean;
}

type Callbacks = {
  /** This frame's videos, best first. Sent even when empty. */
  onCandidates: (videos: { score: number; label: string }[]) => void;
  /** An arrow key was pressed here; the background owns the actual cursor. */
  onNav: (delta: number) => void;
  onConfirm: () => void;
  onPick: (result: PickResult) => void;
  onError: (reason: string) => void;
  onCancel: () => void;
};

let active = false;
let isTopFrame = false;
let highlight: HTMLDivElement | null = null;
let label: HTMLDivElement | null = null;
let banner: HTMLDivElement | null = null;
/** This frame's candidates, in the same order the background indexes them. */
let candidates: VideoCandidate[] = [];
/** Which local candidate is highlighted, or null when the selection is elsewhere. */
let currentIndex: number | null = null;
let cbs: Callbacks | null = null;

const Z = 2147483000; // sit above virtually everything

function styleEl(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

function buildUi() {
  highlight = document.createElement('div');
  styleEl(highlight, {
    position: 'fixed',
    pointerEvents: 'none',
    border: '3px solid #6c5ce7',
    background: 'rgba(108, 92, 231, 0.22)',
    borderRadius: '6px',
    boxShadow: '0 0 0 2000px rgba(0, 0, 0, 0.45)',
    zIndex: String(Z + 1),
    display: 'none',
    transition: 'top 90ms ease-out, left 90ms ease-out, width 90ms ease-out, height 90ms ease-out',
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

  document.body.append(highlight, label);

  // The banner is the top frame's job: the video may be in a nested player
  // iframe, but the instructions belong over the whole page.
  if (!isTopFrame) return;
  banner = document.createElement('div');
  styleEl(banner, {
    position: 'fixed',
    top: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: String(Z + 3),
    minWidth: '320px',
    maxWidth: '90vw',
    padding: '14px 20px',
    borderRadius: '14px',
    background: 'rgba(18,18,28,0.96)',
    color: '#fff',
    font: '400 13px/1.45 system-ui, sans-serif',
    boxShadow: '0 10px 40px rgba(0,0,0,0.55)',
    border: '1px solid rgba(255,255,255,0.12)',
    textAlign: 'center',
    pointerEvents: 'none',
  });
  banner.innerHTML = `
    <div style="font:700 15px/1.3 system-ui,sans-serif;margin-bottom:8px">
      Choose the video to sync
    </div>
    <div data-wp="status" style="color:#c3b9ff;font-weight:600;margin-bottom:8px">
      Looking for videos…
    </div>
    <div style="color:#9a9ab0;font-size:12px">
      <b style="color:#fff">↑ ↓</b> or <b style="color:#fff">← →</b> to browse
      &nbsp;·&nbsp; <b style="color:#fff">Enter</b> to select
      &nbsp;·&nbsp; <b style="color:#fff">Esc</b> to cancel
    </div>
    <div style="margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,0.12);
                color:#ffd479;font-size:12px;line-height:1.4">
      ▶ <b>Start the video playing first.</b> Many players don't create the
      video at all until you hit play, and a stopped one is easy to mistake for
      an advert.
    </div>`;
  document.body.append(banner);
}

/** Draw the highlight over `el`, or hide it when there is nothing selected. */
function paint(el: HTMLVideoElement | null) {
  if (!highlight || !label) return;
  if (!el) {
    highlight.style.display = 'none';
    label.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  styleEl(highlight, {
    display: 'block',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  label.textContent = candidates[currentIndex ?? 0]?.label ?? '<video>';
  styleEl(label, {
    display: 'block',
    // Below the box when it is flush against the top of the viewport.
    top: r.top > 34 ? `${r.top - 28}px` : `${r.top + 6}px`,
    left: `${Math.max(4, r.left)}px`,
  });
}

function repaint() {
  if (!active) return;
  paint(currentIndex === null ? null : (candidates[currentIndex]?.el ?? null));
}

/**
 * Highlight one of this frame's candidates, or clear when the background has
 * moved the selection into a different frame.
 */
export function highlightPick(index: number | null) {
  if (!active) return;
  currentIndex = index;
  const el = index === null ? null : candidates[index]?.el;
  if (el) ensureVisible(el);
  paint(el ?? null);
}

/**
 * Scroll `el` into view unless it is already fully on screen.
 *
 * "Fully" matters: checking only for completely-offscreen left a video with a
 * few pixels peeking over the fold unscrolled, so the highlight was drawn where
 * the user couldn't see it. A player LARGER than the viewport can never be
 * fully visible, so that case instead asks whether it covers the viewport —
 * otherwise every keypress would re-scroll a full-bleed player.
 */
function ensureVisible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const okY = r.height >= vh ? r.top <= 0 && r.bottom >= vh : r.top >= 0 && r.bottom <= vh;
  const okX = r.width >= vw ? r.left <= 0 && r.right >= vw : r.left >= 0 && r.right <= vw;
  if (okY && okX) return;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}

/**
 * Scroll the iframe carrying `origin` into view. Best effort, and only from the
 * top frame: a cross-origin child cannot scroll its parent, so a video inside an
 * off-screen iframe scrolls itself into view within a frame that is itself off
 * screen — the user sees nothing move.
 *
 * Matching is by origin because embed URLs carry per-session tokens. When
 * several iframes share an origin (ad networks, repeated embeds) there is no way
 * to tell which one holds the video, so nothing is scrolled rather than jumping
 * somewhere wrong.
 */
export function revealFrame(origin: string) {
  if (!active || !isTopFrame || !origin) return;
  const matches = [...document.querySelectorAll('iframe')].filter((f) => {
    try {
      return new URL(f.src, location.href).origin === origin;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) return;
  ensureVisible(matches[0]);
}

/** Update the top frame's banner. No-op in every other frame. */
export function showPickBanner(position: number, total: number, text: string) {
  const status = banner?.querySelector<HTMLElement>('[data-wp="status"]');
  if (!status) return;
  status.textContent = total === 0 ? 'No video found on this page' : `Video ${position} of ${total} · ${text}`;
}

/**
 * Resolve one of this frame's candidates into a stored selector and report it.
 * Called when the user pressed Enter and the background determined that the
 * selection lives here.
 */
export function takePick(index: number) {
  const video = candidates[index]?.el;
  if (!video) {
    cbs?.onError('That video is no longer on the page.');
    return;
  }
  try {
    const selector = finder(video, { root: document.body, timeoutMs: 1000 });
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
  if (!active) return;
  const nav =
    e.key === 'ArrowDown' || e.key === 'ArrowRight'
      ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
        ? -1
        : 0;

  if (nav === 0 && e.key !== 'Enter' && e.key !== 'Escape') return;

  // Streaming players bind arrows to seek and Enter to fullscreen. Swallow the
  // event in the capture phase so picking never disturbs the page underneath.
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    finish();
    cbs?.onCancel();
    return;
  }
  if (e.key === 'Enter') {
    cbs?.onConfirm();
    return;
  }
  cbs?.onNav(nav);
}

export function startPicker(callbacks: Callbacks & { isTop: boolean }) {
  if (active || !document.body) return;
  cbs = callbacks;
  isTopFrame = callbacks.isTop;
  active = true;
  currentIndex = null;
  candidates = rankedVideos();
  buildUi();

  // Every frame listens, including ones with no video: key events only reach
  // the frame that holds focus, and that may well be an ad iframe.
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', repaint, true);
  window.addEventListener('resize', repaint, true);

  callbacks.onCandidates(candidates.map((c) => ({ score: c.score, label: c.label })));
}

/**
 * Tear the picker down without reporting a cancellation.
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
  currentIndex = null;
  candidates = [];
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', repaint, true);
  window.removeEventListener('resize', repaint, true);
  banner?.remove();
  highlight?.remove();
  label?.remove();
  highlight = label = banner = null;
}
