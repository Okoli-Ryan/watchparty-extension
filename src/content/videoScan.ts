// Finding and ranking the <video> elements in a document.
//
// Shared by the picker (which offers them in likelihood order) and the video
// controller (which falls back to the best one when a stored selector stops
// matching). Keeping one definition of "most likely the main video" means the
// element the user picked is the same one the controller would fall back to.

export interface VideoCandidate {
  el: HTMLVideoElement;
  score: number;
  /** Short human description for the picker banner, e.g. "1280×720 · playing". */
  label: string;
}

/** Every <video> in the document, including inside open shadow roots. */
export function collectVideos(root: Document | ShadowRoot = document): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [...root.querySelectorAll('video')];
  // querySelector doesn't pierce shadow boundaries, so walk them explicitly —
  // several player frameworks mount the <video> inside a shadow root.
  for (const el of root.querySelectorAll('*')) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) found.push(...collectVideos(shadow));
  }
  return found;
}

/**
 * Rank candidate videos so the real player sorts above a hidden preview or an
 * advert. Prefers visible, large, loaded, playing media. A negative score means
 * "not a usable candidate" and is filtered out.
 */
export function scoreVideo(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  const visible = r.width > 1 && r.height > 1;
  if (!visible) return -1;
  let score = r.width * r.height;
  if (Number.isFinite(v.duration) && v.duration > 0) score += 250_000;
  if (v.readyState > 0) score += 250_000;
  if (!v.paused) score += 500_000;
  // Very short media is usually a background loop or an ad bumper.
  if (Number.isFinite(v.duration) && v.duration > 0 && v.duration < 30) score -= 400_000;
  return score;
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** "1280×720 · 1:42:30 · playing" — enough to tell two players apart. */
function describe(v: HTMLVideoElement): string {
  const r = v.getBoundingClientRect();
  const parts = [`${Math.round(r.width)}×${Math.round(r.height)}`];
  if (Number.isFinite(v.duration) && v.duration > 0) parts.push(clock(v.duration));
  if (!v.paused) parts.push('playing');
  else if (v.readyState === 0) parts.push('not loaded');
  return parts.join(' · ');
}

/**
 * Usable videos in this document, best first. This ordering is what the picker
 * steps through, so index 0 is the one most likely to be wanted.
 */
export function rankedVideos(): VideoCandidate[] {
  return collectVideos()
    .map((el) => ({ el, score: scoreVideo(el), label: describe(el) }))
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

/** Best guess at the page's main video, or null if there isn't a usable one. */
export function bestVideo(): HTMLVideoElement | null {
  return rankedVideos()[0]?.el ?? null;
}
