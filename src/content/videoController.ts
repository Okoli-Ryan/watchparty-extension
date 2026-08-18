import { DRIFT_THRESHOLD, ELEMENT_WAIT_MS } from '../shared/constants';
import { log, warn, fail } from '../shared/log';
import type { MemberRole, PlaybackState } from '../shared/types';

// Pure-DOM controller: attaches to a <video> by selector and either emits the
// owner's playback events or mirrors the owner's state onto a viewer's player.

export interface ControllerCallbacks {
  onEvent: (e: {
    event: 'play' | 'pause' | 'seeked' | 'ratechange' | 'sync';
    currentTime: number;
    isPlaying: boolean;
    rate: number;
  }) => void;
  onAttached: () => void;
  onError: (reason: string) => void;
  /** Reports the media length so chat timestamps can be range-checked. */
  onMeta: (duration: number) => void;
}

export const NOT_FOUND_MESSAGE =
  "Couldn't find the video. Start playback on the page, then press Retry.";

/** Every <video> in the document, including inside open shadow roots. */
function collectVideos(root: Document | ShadowRoot = document): HTMLVideoElement[] {
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
 * Rank candidate videos so a fallback picks the real player rather than a
 * hidden preview or an advert. Prefers visible, large, loaded, playing media.
 */
function scoreVideo(v: HTMLVideoElement): number {
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

/** Best guess at the page's main video, or null if there isn't a usable one. */
function bestVideo(): HTMLVideoElement | null {
  const ranked = collectVideos()
    .map((v) => ({ v, s: scoreVideo(v) }))
    .filter((c) => c.s >= 0)
    .sort((a, b) => b.s - a.s);
  return ranked[0]?.v ?? null;
}

export class VideoController {
  private video: HTMLVideoElement | null = null;
  private role: MemberRole;
  private cbs: ControllerCallbacks;
  /** While Date.now() < this, ignore video events we caused ourselves. */
  private suppressUntil = 0;
  /** updatedAt (ms) of the newest snapshot applied, to reject stale ones. */
  private lastAppliedMs = 0;
  /** Local clock reading when the newest remote state arrived. */
  private remoteReceivedAt = 0;
  private unmuteChip: HTMLElement | null = null;
  private gateOverlay: HTMLElement | null = null;
  private mo: MutationObserver | null = null;
  private detached = false;
  private lastRemote: PlaybackState | null = null;

  constructor(
    private selector: string,
    role: MemberRole,
    cbs: ControllerCallbacks,
  ) {
    this.role = role;
    this.cbs = cbs;
  }

  /** How an owner reconciles with the room's stored position on attach. */
  ownerMode: 'publish' | 'adopt' = 'publish';
  /** Room playback handed over with ATTACH, used when ownerMode is 'adopt'. */
  initialRemote: PlaybackState | null = null;

  async attach(): Promise<void> {
    log('content', `attach as ${this.role}`, `selector=${this.selector}`);
    const video = await this.waitForVideo();
    if (this.detached) return;
    if (!video) {
      fail('content', 'video NOT found for selector', this.selector);
      this.cbs.onError(NOT_FOUND_MESSAGE);
      return;
    }
    log('content', 'video found', `duration=${video.duration}`, `paused=${video.paused}`);
    this.video = video;
    this.bindOwnerListeners();
    if (this.role === 'viewer') this.showJoinGate();
    this.cbs.onAttached();

    // Replay any owner state that arrived before the video was ready, so the
    // viewer starts out matching the owner instead of guessing.
    if (this.role === 'viewer' && this.lastRemote) {
      log('viewer', 'replaying owner state buffered during attach');
      this.lastAppliedMs = 0;
      this.apply(this.lastRemote);
    }
    if (this.role === 'owner') {
      if (this.ownerMode === 'adopt' && this.initialRemote) {
        // Returning host: this page just loaded at 0:00, but the room is mid-
        // playback. Move to the room's position instead of publishing ours,
        // which would reset every viewer to the start.
        log('content', 'owner adopting room position on attach');
        this.apply(this.initialRemote, true);
      } else {
        // Room created here — this player is the source of truth. Publish the
        // real state (e.g. it was already playing when it was picked).
        this.reportState();
      }
    }
  }

  /**
   * Owner-only: publish the current seek position + play state on demand. Used
   * when a new viewer joins so they resume from where the owner actually is.
   */
  reportState() {
    if (this.role !== 'owner' || !this.video) return;
    this.emit('sync');
  }


  /**
   * Viewer: jump to where the host should be right now.
   *
   * Sync is event-driven, so a viewer who drifted (buffering, a manual scrub)
   * stays out of step until the host next acts. This re-applies the last known
   * host state, extrapolated forward from when we received it — accurate as long
   * as the host has been playing continuously since.
   */
  resync(state: PlaybackState, elapsedMs: number): string {
    const video = this.video;
    if (!video) return "Can't sync — no video attached";

    // Where the host is NOW: their last published position advanced by the time
    // since they published it. `elapsedMs` is measured on the background's
    // calibrated server clock, so this doesn't depend on our own clock or on
    // how stale our local copy of the state happens to be.
    const target = state.isPlaying
      ? state.currentTime + (Math.max(0, elapsedMs) / 1000) * (state.rate || 1)
      : state.currentTime;

    const drift = video.currentTime - target;
    const actions: string[] = [];

    // A deliberate request gets a tighter tolerance than passive drift
    // correction — the user asked to be exactly where the host is.
    if (Math.abs(drift) > 0.5) {
      try {
        video.currentTime = target;
        actions.push('position');
      } catch (e) {
        warn('viewer', 'player rejected the resync seek', e);
        return "Player wouldn't seek";
      }
    }

    // Always enforce the host's transport state, even if the position matched.
    if (state.isPlaying && video.paused) {
      void this.safePlay();
      actions.push('resumed');
    } else if (!state.isPlaying && !video.paused) {
      video.pause();
      actions.push('paused');
    }

    if (typeof state.rate === 'number' && Math.abs(video.playbackRate - state.rate) > 0.01) {
      video.playbackRate = state.rate;
      actions.push('speed');
    }

    // Record what we just aligned to, so ordinary APPLY handling stays coherent.
    this.lastRemote = state;
    this.remoteReceivedAt = Date.now() - Math.max(0, elapsedMs);
    this.suppressUntil = Date.now() + 800;

    log('viewer', 'manual resync', `drift=${drift.toFixed(2)}s`, `target=${target.toFixed(2)}`);
    if (actions.length === 0) return 'Already in sync';
    return `Synced (${actions.join(', ')})`;
  }

  setRole(role: MemberRole) {
    if (role === this.role) return;
    log('content', `role change ${this.role} → ${role}`);
    this.role = role;
    // When promoted to owner, stop mirroring and publish our current state so
    // Firestore reflects this player as the new source of truth.
    if (role === 'owner') {
      this.hideJoinGate();
      this.unmuteChip?.remove();
      this.unmuteChip = null;
      this.reportState();
    }
  }

  /**
   * Mirror the owner's latest playback state.
   *
   * `force` lets an attaching OWNER adopt the room's position once — normally
   * owners never apply remote state, since they are the source of truth.
   */
  apply(state: PlaybackState, force = false) {
    // Drop snapshots older than the one we already applied. Any room-doc write
    // (presence, owner rename) re-delivers `playback`, and out-of-order or
    // cached snapshots must never resurrect a superseded play/pause.
    const incomingMs = state.updatedAt?.toMillis?.() ?? null;
    if (incomingMs !== null && incomingMs < this.lastAppliedMs) {
      log('viewer', 'ignoring stale snapshot', `${incomingMs} < ${this.lastAppliedMs}`);
      return;
    }

    // Record the owner's state BEFORE any guard can drop it. If the video isn't
    // attached yet, attach() replays this. (Losing it here is what previously
    // left the viewer with no idea what the owner was doing, so the join gate
    // fell back to blindly playing.)
    this.lastRemote = state;
    this.remoteReceivedAt = Date.now();

    if ((this.role !== 'viewer' && !force) || !this.video) {
      warn('viewer', 'apply deferred — will replay on attach', {
        role: this.role,
        hasVideo: !!this.video,
      });
      return;
    }
    if (incomingMs !== null) this.lastAppliedMs = incomingMs;

    const video = this.video;
    // Suppress our own resulting events. Uses a deadline rather than a 50ms
    // timer because play() and seeks resolve asynchronously — often well after
    // 50ms on a network-backed video.
    this.suppressUntil = Date.now() + 800;
    const actions: string[] = [];

    // Rate.
    if (typeof state.rate === 'number' && Math.abs(video.playbackRate - state.rate) > 0.01) {
      video.playbackRate = state.rate;
      actions.push(`rate→${state.rate}`);
    }

    // Realign position only when the gap is meaningful. Every apply() is driven
    // by a real host action (the background suppresses no-op snapshots), so this
    // runs at events — not on a timer.
    const target = this.projectedTime(state);
    const drift = video.currentTime - target;
    if (Math.abs(drift) > DRIFT_THRESHOLD) {
      try {
        video.currentTime = target;
        actions.push(`seek ${video.currentTime.toFixed(2)}→${target.toFixed(2)}`);
      } catch (e) {
        fail('viewer', 'seek rejected by player', e);
      }
    }

    // Play / pause.
    if (state.isPlaying && video.paused) {
      actions.push('play');
      void this.safePlay();
    } else if (!state.isPlaying && !video.paused) {
      video.pause();
      actions.push('pause');
    }

    log(
      'viewer',
      'apply',
      `remote(t=${state.currentTime.toFixed(2)} playing=${state.isPlaying})`,
      `drift=${drift.toFixed(2)}s`,
      actions.length ? `→ ${actions.join(', ')}` : '→ no-op (already in sync)',
    );

  }

  detach() {
    this.detached = true;
    this.mo?.disconnect();
    this.mo = null;
    if (this.video) {
      this.video.removeEventListener('play', this.onVideoEvent);
      this.video.removeEventListener('pause', this.onVideoEvent);
      this.video.removeEventListener('seeked', this.onVideoEvent);
      this.video.removeEventListener('ratechange', this.onVideoEvent);
      this.video.removeEventListener('loadedmetadata', this.reportMeta);
      this.video.removeEventListener('durationchange', this.reportMeta);
    }
    this.hideJoinGate();
    this.unmuteChip?.remove();
    this.unmuteChip = null;
    this.video = null;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Where the owner's playhead should be *now*.
   *
   * Extrapolates from when WE received the state, not from its server
   * `updatedAt`. Comparing a server timestamp against the local `Date.now()`
   * mixes two clocks, and any skew became a permanent seek offset. The owner
   * republishes its position every PLAYBACK_SYNC_MS while playing, so this
   * only ever extrapolates a few seconds.
   */
  private projectedTime(state: PlaybackState): number {
    if (!state.isPlaying) return state.currentTime;
    const elapsed = (Date.now() - this.remoteReceivedAt) / 1000;
    return state.currentTime + Math.max(0, elapsed) * (state.rate || 1);
  }

  /**
   * Find the room's video, degrading gracefully.
   *
   * The stored selector is generated from the host's DOM, and streaming sites
   * routinely break it: hashed class names differ between sessions, the player
   * is rebuilt when you switch source/quality, and many sites don't create the
   * <video> at all until playback starts. So we wait for the exact selector,
   * then fall back to the most plausible video actually on the page.
   */
  private waitForVideo(): Promise<HTMLVideoElement | null> {
    const exact = this.query();
    if (exact) return Promise.resolve(exact);

    return new Promise((resolve) => {
      const deadline = Date.now() + ELEMENT_WAIT_MS;
      const finish = (v: HTMLVideoElement | null) => {
        this.mo?.disconnect();
        this.mo = null;
        resolve(v);
      };

      const check = () => {
        const hit = this.query();
        if (hit) return finish(hit);
        if (Date.now() > deadline) {
          // Selector never matched — take the best real video instead.
          const fallback = bestVideo();
          if (fallback) {
            warn('content', 'selector did not match; using best video on page', this.selector);
          }
          finish(fallback);
        }
      };

      this.mo = new MutationObserver(check);
      this.mo.observe(document.documentElement, { childList: true, subtree: true });
      // Players often appear with no DOM mutation we observe (e.g. inside a
      // shadow root), so poll as well as observe.
      const poll = setInterval(() => {
        if (!this.mo) return clearInterval(poll);
        check();
      }, 500);
      setTimeout(() => {
        clearInterval(poll);
        if (this.mo) check();
      }, ELEMENT_WAIT_MS + 100);
    });
  }

  /**
   * Jump to an absolute position — used by clickable timestamps in chat.
   *
   * The host's jump propagates automatically, because the resulting `seeked`
   * event is published like any other host action. A viewer's jump is local;
   * "Sync with host" brings them back.
   */
  seekTo(seconds: number) {
    const video = this.video;
    if (!video) return;
    const max = Number.isFinite(video.duration) ? video.duration : Infinity;
    if (seconds < 0 || seconds > max) {
      warn('content', `seek ${seconds}s out of range (duration ${video.duration})`);
      return;
    }
    log('content', `seeking to ${seconds}s from chat timestamp`);
    try {
      video.currentTime = seconds;
    } catch (e) {
      warn('content', 'player rejected the seek', e);
    }
  }

  private reportMeta = () => {
    if (!this.video) return;
    const d = this.video.duration;
    this.cbs.onMeta(Number.isFinite(d) && d > 0 ? d : 0);
  };

  /** Re-run the search — used by the widget's Retry button. */
  async retry(): Promise<void> {
    if (this.video || this.detached) return;
    log('content', 'retrying video lookup');
    const v = await this.waitForVideo();
    if (!v || this.detached) {
      this.cbs.onError(NOT_FOUND_MESSAGE);
      return;
    }
    this.video = v;
    this.bindOwnerListeners();
    this.cbs.onAttached();
    if (this.role === 'viewer' && this.lastRemote) {
      this.lastAppliedMs = 0;
      this.apply(this.lastRemote);
    }
  }

  private query(): HTMLVideoElement | null {
    try {
      const el = document.querySelector(this.selector);
      if (el instanceof HTMLVideoElement) return el;
    } catch {
      /* selector became invalid — fall through */
    }
    return null;
  }

  private bindOwnerListeners() {
    const v = this.video!;
    v.addEventListener('play', this.onVideoEvent);
    v.addEventListener('pause', this.onVideoEvent);
    v.addEventListener('seeked', this.onVideoEvent);
    v.addEventListener('ratechange', this.onVideoEvent);
    // Duration often isn't known at attach time, and can change when the player
    // swaps source — report it now and whenever it settles.
    v.addEventListener('loadedmetadata', this.reportMeta);
    v.addEventListener('durationchange', this.reportMeta);
    this.reportMeta();
  }

  private onVideoEvent = (ev: Event) => {
    // Only the owner reports; viewers stay silent to avoid feedback loops. Also
    // ignore events we ourselves triggered while applying remote state.
    if (this.role !== 'owner' || !this.video) return;
    if (Date.now() < this.suppressUntil) {
      log('content', `suppressed self-inflicted ${ev.type}`);
      return;
    }
    this.emit(ev.type as any);
  };

  private emit(event: 'play' | 'pause' | 'seeked' | 'ratechange' | 'sync') {
    if (!this.video) return;
    const payload = {
      event,
      currentTime: this.video.currentTime,
      isPlaying: !this.video.paused,
      rate: this.video.playbackRate,
    };
    log('owner', `emit ${event}`, `t=${payload.currentTime.toFixed(2)}s`, `playing=${payload.isPlaying}`);
    this.cbs.onEvent(payload);
  }

  /**
   * Layered autoplay workaround. Programmatic play() is blocked until a user
   * gesture in the page:
   *   1. try to play as-is (works once the join gate was clicked);
   *   2. on NotAllowedError, mute and retry (muted autoplay is always allowed)
   *      and show an unmute chip;
   *   3. if even that fails, surface a real "can't control this player" error.
   */
  private async safePlay(): Promise<void> {
    const video = this.video;
    if (!video) return;
    try {
      await video.play();
      log('viewer', 'play() ok (unmuted)');
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name !== 'NotAllowedError') {
        // Logged, but deliberately not surfaced: a rejected play() is usually
        // transient (the player swapped source, a seek was in flight) and the
        // banner fired far more often than it was useful.
        warn('viewer', 'play() rejected', err);
        return;
      }
      // Layer 2: muted retry (muted autoplay is exempt from the policy).
      warn('viewer', 'play() blocked by autoplay policy → retrying muted');
      try {
        video.muted = true;
        await video.play();
        log('viewer', 'play() ok (muted fallback)');
        this.showUnmuteChip();
      } catch (err2) {
        // The join gate is already on screen for this case, so the user has an
        // obvious way to start playback — no error banner needed.
        warn('viewer', 'muted play() also failed; awaiting user gesture', err2);
      }
    }
  }

  // --- viewer gesture UI ---------------------------------------------------

  private showJoinGate() {
    if (this.gateOverlay) return;
    const btn = document.createElement('button');
    btn.textContent = '▶  Click to start watching together';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483000',
      padding: '12px 20px',
      borderRadius: '999px',
      border: 'none',
      background: '#6c5ce7',
      color: '#fff',
      font: '600 14px/1 system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    } as Partial<CSSStyleDeclaration>);
    btn.addEventListener('click', () => {
      // Genuine user gesture: unlocks unmuted play() for the session. Only ever
      // mirror the owner — never blind-play, or we'd start playing while the
      // owner sits paused.
      this.hideJoinGate();
      if (this.lastRemote) {
        // Re-apply the newest known state; clear the monotonic guard so this
        // deliberate replay isn't rejected as stale.
        this.lastAppliedMs = 0;
        this.apply(this.lastRemote);
      } else {
        log('viewer', 'gate clicked with no owner state yet — waiting for snapshot');
      }
    });
    document.body.appendChild(btn);
    this.gateOverlay = btn;
  }

  private hideJoinGate() {
    this.gateOverlay?.remove();
    this.gateOverlay = null;
  }

  private showUnmuteChip() {
    if (this.unmuteChip) return;
    const chip = document.createElement('button');
    chip.textContent = '🔇  Muted — click to unmute';
    Object.assign(chip.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '2147483000',
      padding: '10px 16px',
      borderRadius: '999px',
      border: 'none',
      background: 'rgba(20,20,30,0.92)',
      color: '#fff',
      font: '600 13px/1 system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
    } as Partial<CSSStyleDeclaration>);
    chip.addEventListener('click', () => {
      if (this.video) this.video.muted = false;
      chip.remove();
      this.unmuteChip = null;
    });
    document.body.appendChild(chip);
    this.unmuteChip = chip;
  }
}
