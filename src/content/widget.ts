import type { RoomInfo } from '../shared/messages';
import type { ChatMessage } from '../shared/types';
import { CHAT_MAX_LEN } from '../shared/constants';

// Floating on-page widget: a small pill that expands into a status panel.
// Rendered inside a shadow root so the host page's CSS can't reach it — these
// streaming pages are aggressive with global styles and high z-indexes.

const HOST_ID = 'watchparty-widget-host';
const Z = 2147483600; // above the picker overlay and the page's own chrome

/** Persisted widget position, in px from the viewport's top-left. */
export interface WidgetPos {
  x: number;
  y: number;
}

export interface WidgetCallbacks {
  onLeave: () => void;
  onSend: (text: string) => void;
  onOpenDashboard: () => void;
  onResync: () => void;
  onRetry: () => void;
  onSeek: (seconds: number) => void;
  onTransferHost: (uid: string) => void;
  onReselectVideo: () => void;
  onMove: (pos: WidgetPos) => void;
}

/**
 * Short two-tone blip for an incoming message, synthesised with WebAudio so no
 * audio asset has to ship (and no host-page CSP can block a media file).
 */
function beep() {
  try {
    const Ctx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.09);
    // Quiet, and faded out so it doesn't click.
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio unavailable (no gesture yet, blocked context) — never fatal */
  }
}

export class Widget {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private expanded = false;
  private info: RoomInfo | null = null;
  private error: string | null = null;
  private chatOpen = false;
  private messages: ChatMessage[] = [];
  /** null until the first batch lands, so the backfill doesn't beep. */
  private seenMessageIds: Set<string> | null = null;
  private beepEnabled = true;
  private reactionOpen = false;
  /** Messages from others that arrived while the chat wasn't on screen. */
  private unread = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Half-typed chat message, preserved across structural rebuilds. */
  private draft = '';
  private pos: WidgetPos | null = null;
  private dragging = false;
  /** Set while a drag is in progress so it doesn't fire a click on release. */
  private dragMoved = false;
  /** Structure currently built, so updates can patch instead of rebuilding. */
  private builtFor: string | null = null;

  constructor(private cbs: WidgetCallbacks) {}

  mount() {
    if (this.host || !document.body) return;
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    // The host element itself must not intercept clicks outside the widget.
    Object.assign(this.host.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: String(Z),
      width: 'auto',
      height: 'auto',
      pointerEvents: 'auto',
    } as Partial<CSSStyleDeclaration>);
    this.root = this.host.attachShadow({ mode: 'open' });
    // `.toasts` is a sibling of `.wrap` so reaction popups survive every
    // rebuild of the pill/panel and never affect its render signature.
    this.root.innerHTML = `<style>${CSS}</style><div class="toasts"></div><div class="wrap"></div>`;
    document.body.appendChild(this.host);
    this.render();
  }

  update(info: RoomInfo) {
    this.info = info;
    this.render();
  }

  setMessages(messages: ChatMessage[]) {
    const previous = this.seenMessageIds;
    const isFirstLoad = previous === null;
    const incoming = new Set(messages.map((m) => m.id));

    // Only messages that are genuinely new, from someone else, and not part of
    // the initial backfill when you first open the room.
    if (!isFirstLoad) {
      const fresh = messages.filter(
        (m) => !previous.has(m.id) && m.senderUid !== this.info?.myUid,
      );
      if (fresh.length > 0 && this.beepEnabled) beep();

      // Reactions flash over the widget — but only when the chat isn't already
      // on screen, where they'd show up in the list anyway.
      const chatVisible = this.expanded && this.chatOpen;
      if (!chatVisible) {
        for (const m of fresh) {
          if (isReaction(m.text)) this.showToast(m.senderName, m.text.trim());
        }
        // Nobody is reading the transcript, so flag these as unread.
        this.unread += fresh.length;
      }
    }

    this.seenMessageIds = incoming;
    this.messages = messages;
    this.render();
  }

  setBeepEnabled(enabled: boolean) {
    this.beepEnabled = enabled;
  }

  /**
   * Show the outcome of a re-sync on the button, then restore its label. The
   * text comes from the controller, so it reflects what actually happened
   * rather than assuming the sync worked.
   */
  setResyncStatus(text: string) {
    const btn = this.root?.querySelector<HTMLButtonElement>('.resync');
    if (!btn) return;
    btn.textContent = text;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    if (text === 'Syncing…') return; // wait for the real result
    this.resyncTimer = setTimeout(() => {
      const b = this.root?.querySelector<HTMLButtonElement>('.resync');
      if (b) b.textContent = '⟲ Sync with host';
    }, 2000);
  }

  /** Restore a saved position (called once, after mount). */
  setPosition(pos: WidgetPos | null) {
    if (!pos) return;
    this.pos = pos;
    this.applyPosition();
  }

  /**
   * Move the widget with the pointer. Bound to the pill and the panel header so
   * the rest of the UI stays clickable. A drag that actually moved suppresses
   * the click that would otherwise expand/collapse on release.
   */
  private beginDrag(e: PointerEvent) {
    if (!this.host || e.button !== 0) return;
    const rect = this.host.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    this.dragging = true;
    this.dragMoved = false;

    const move = (ev: PointerEvent) => {
      if (!this.dragging || !this.host) return;
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) {
        this.dragMoved = true;
      }
      // Keep it on screen whatever the viewport size.
      const w = rect.width || 60;
      const h = rect.height || 40;
      const x = Math.min(Math.max(0, ev.clientX - offX), Math.max(0, window.innerWidth - w));
      const y = Math.min(Math.max(0, ev.clientY - offY), Math.max(0, window.innerHeight - h));
      this.pos = { x, y };
      this.applyPosition();
    };

    const up = () => {
      this.dragging = false;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      if (this.dragMoved && this.pos) this.cbs.onMove(this.pos);
      // Let the click handler run first, then clear the flag.
      setTimeout(() => (this.dragMoved = false), 0);
    };

    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  /** Switch from the default bottom-right anchoring to explicit coordinates. */
  private applyPosition() {
    if (!this.host || !this.pos) return;
    Object.assign(this.host.style, {
      left: `${this.pos.x}px`,
      top: `${this.pos.y}px`,
      right: 'auto',
      bottom: 'auto',
    } as Partial<CSSStyleDeclaration>);
  }

  private makeDraggable(el: Element | null) {
    el?.addEventListener('pointerdown', (e) => this.beginDrag(e as PointerEvent));
  }

  /**
   * Flash a reaction above the widget for a few seconds. Rendered into the
   * `.toasts` container, which sits outside `.wrap` so it is untouched by
   * pill/panel rebuilds.
   */
  private showToast(who: string, emoji: string) {
    const host = this.root?.querySelector('.toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="t-emoji">${esc(emoji)}</span><span class="t-who">${esc(who)}</span>`;
    host.appendChild(el);
    // Keep the stack short if reactions arrive in a burst.
    while (host.childElementCount > 4) host.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, 3000);
  }

  setError(message: string | null) {
    this.error = message;
    this.render();
  }

  destroy() {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.info = null;
    this.error = null;
    this.expanded = false;
  }

  private render() {
    if (!this.root) return;
    const wrap = this.root.querySelector('.wrap');
    if (!wrap) return;

    // Only rebuild the DOM when the *structure* changes. Messages arriving
    // while you're mid-sentence must not wipe the input or steal focus.
    // The role must be part of the signature: host and viewer get different
    // controls, and those are structural. Without it a handoff only repainted
    // the text, leaving a new host looking at "Sync with host".
    const signature = !this.expanded
      ? `pill:${this.reactionOpen}`
      : `panel:${this.chatOpen}:${this.info?.role ?? '?'}`;
    if (signature === this.builtFor) {
      this.patch(wrap as HTMLElement);
      return;
    }
    this.builtFor = signature;
    this.build(wrap as HTMLElement);
  }

  /** Update only the volatile parts of the existing structure. */
  private patch(wrap: HTMLElement) {
    const i = this.info;
    if (!this.expanded) {
      const pill = wrap.querySelector<HTMLElement>('.pill');
      const dot = wrap.querySelector<HTMLElement>('.dot');
      const role = wrap.querySelector<HTMLElement>('.role');
      const text = wrap.querySelector<HTMLElement>('.pill-text');
      const count = wrap.querySelector<HTMLElement>('.count');
      if (dot) dot.className = `dot ${i?.isPlaying ? 'playing' : ''}`;
      if (text) text.textContent = i ? shorten(i.name, 16) : 'WatchParty';
      if (role) {
        // Reveal the HOST/VIEWER chip once we know which we are.
        role.className = i ? `role ${i.role}` : 'role hide';
        role.textContent = i ? roleLabel(i.role) : '';
      }
      if (count) {
        count.className = i ? 'count' : 'count hide';
        count.textContent = i ? String(i.members) : '';
      }
      if (pill && i) pill.title = `You are the ${roleLabel(i.role).toLowerCase()} — click to expand`;
      const unread = wrap.querySelector<HTMLElement>('.unread');
      if (unread) {
        unread.className = this.unread > 0 ? 'unread' : 'unread hide';
        unread.textContent = this.unread > 99 ? '99+' : String(this.unread);
      }
      return;
    }
    if (i) {
      this.setText(wrap, '[data-f="title"]', i.name);
      this.setText(wrap, '[data-f="host"]', i.ownerName);
      this.setText(wrap, '[data-f="members"]', String(i.members));
      this.setText(wrap, '[data-f="state"]', i.isPlaying ? '▶ playing' : '⏸ paused');
      const badge = wrap.querySelector('[data-f="role"]');
      if (badge) {
        badge.className = `v badge ${i.role}`;
        badge.textContent = roleLabel(i.role);
      }
    }
    // Roster changes (someone joined or left) refresh in place rather than
    // rebuilding the panel, so a half-typed chat message survives.
    //
    // The key is `roster`, NOT `members`. The "Watching" row above is also a
    // data-f field, and when both used `members` querySelector returned the
    // count span — so this overwrote the count with the roster markup and the
    // real roster never updated at all.
    const roster = wrap.querySelector<HTMLElement>('[data-f="roster"]');
    if (roster && i) {
      const next = membersHtml(i);
      if (roster.innerHTML !== next) roster.innerHTML = next;
    }

    // Unread count on the Chat button, for messages arriving while the panel is
    // open but the transcript is hidden.
    this.setText(wrap, '[data-f="chatlabel"]', this.chatOpen ? 'Hide chat' : '💬 Chat');
    const tbadge = wrap.querySelector<HTMLElement>('[data-f="tbadge"]');
    if (tbadge) {
      const show = !this.chatOpen && this.unread > 0;
      tbadge.className = show ? 'tbadge' : 'tbadge hide';
      tbadge.textContent = this.unread > 99 ? '99+' : String(this.unread);
    }

    const err = wrap.querySelector<HTMLElement>('[data-f="err"]');
    if (err) err.style.display = this.error ? 'block' : 'none';
    // Patch only the text node, or the Retry button inside would be destroyed.
    this.setText(wrap, '[data-f="errtext"]', this.error ?? '');
    if (this.chatOpen) this.renderMessages(wrap);
  }

  private setText(wrap: HTMLElement, sel: string, value: string) {
    const el = wrap.querySelector(sel);
    if (el) el.textContent = value;
  }

  private renderMessages(wrap: HTMLElement) {
    const list = wrap.querySelector<HTMLElement>('.messages');
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = this.messages.length
      ? this.messages
          .map(
            (m) => `
        <div class="msg${m.senderUid === this.info?.myUid ? ' mine' : ''}">
          <span class="who">${esc(m.senderName)}</span>
          <span class="body">${renderBody(m.text, this.info?.duration ?? 0)}</span>
        </div>`,
          )
          .join('')
      : '<div class="empty-chat">No messages yet — say hello 👋</div>';
    // Keep pinned to the newest unless the user has scrolled up to read back.
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  private build(wrap: HTMLElement) {
    const i = this.info;
    // A rebuild replaces the composer, so carry any half-typed message across.
    // Ownership handoff now triggers a rebuild, and it must not eat your draft.
    const draft = wrap.querySelector<HTMLInputElement>('.chat-input')?.value ?? this.draft;
    this.draft = draft;

    if (!this.expanded) {
      // Always emit the full structure — `patch()` fills it in as info arrives.
      // Building conditionally meant the role/count spans never existed, since
      // the widget mounts before the first ROOM_INFO.
      wrap.innerHTML = `
        ${
          this.reactionOpen
            ? `<div class="picker">
                 ${REACTIONS.map(
                   (e) => `<button class="emoji" data-e="${e}" title="Send ${e}">${e}</button>`,
                 ).join('')}
               </div>`
            : ''
        }
        <div class="pillrow">
          <button class="react" title="Quick reaction">☺</button>
          <button class="pill">
            <span class="dot"></span>
            <span class="role hide"></span>
            <span class="pill-text">WatchParty</span>
            <span class="count hide"></span>
          </button>
          <span class="unread hide" title="Unread messages"></span>
        </div>`;

      wrap.querySelector('.react')?.addEventListener('click', () => {
        this.reactionOpen = !this.reactionOpen;
        this.render();
      });
      wrap.querySelectorAll<HTMLElement>('.emoji').forEach((btn) =>
        btn.addEventListener('click', () => {
          const emoji = btn.dataset.e;
          if (emoji) this.cbs.onSend(emoji);
          this.reactionOpen = false;
          this.render();
        }),
      );
      const pill = wrap.querySelector('.pill');
      pill?.addEventListener('click', () => {
        if (this.dragMoved) return; // that was a drag, not a click
        this.expanded = true;
        this.render();
      });
      this.makeDraggable(pill);
      // Fill the placeholders (role chip, count, unread badge) in one place.
      this.patch(wrap);
      return;
    }

    wrap.innerHTML = `
      <div class="panel${this.chatOpen ? ' with-chat' : ''}">
        <div class="head">
          <div class="title" data-f="title">${i ? esc(i.name) : 'WatchParty'}</div>
          <button class="close" title="Collapse">×</button>
        </div>
        <div class="rows">
          <div class="row"><span class="k">You are</span><span class="v badge ${i?.role ?? ''}" data-f="role">${i ? roleLabel(i.role) : '—'}</span></div>
          <div class="row"><span class="k">Host</span><span class="v" data-f="host">${i ? esc(i.ownerName) : '—'}</span></div>
          <div class="row"><span class="k">Watching</span><span class="v" data-f="members">${i?.members ?? '—'}</span></div>
          <div class="row"><span class="k">State</span><span class="v" data-f="state">${i ? (i.isPlaying ? '▶ playing' : '⏸ paused') : '—'}</span></div>
        </div>
        <div class="err" data-f="err" style="display:${this.error ? 'block' : 'none'}">
          <span data-f="errtext">${esc(this.error ?? '')}</span>
          <button class="retry">Retry</button>
        </div>
        ${
          this.chatOpen
            ? `<div class="chat">
                 <div class="messages"></div>
                 <form class="composer">
                   <input class="chat-input" type="text" placeholder="Message…"
                          maxlength="${CHAT_MAX_LEN}" autocomplete="off" />
                   <button class="send" type="submit" title="Send">➤</button>
                 </form>
               </div>`
            : ''
        }
        ${
          i?.role === 'viewer'
            ? `<button class="resync" title="Jump to where the host is now — and follow them if they've changed video">⟲ Sync with host</button>`
            : ''
        }
        ${
          i?.role === 'owner'
            ? `<button class="reselect" title="Point the room at a different video">⇄ Change video</button>`
            : ''
        }
        ${i?.role === 'owner' ? `<div class="members" data-f="roster">${membersHtml(i)}</div>` : ''}
        <div class="actions">
          <button class="chat-toggle">
            <span data-f="chatlabel">${this.chatOpen ? 'Hide chat' : '💬 Chat'}</span>
            <span class="tbadge hide" data-f="tbadge"></span>
          </button>
          <button class="dash" title="Open the dashboard in a new tab">⧉ Dashboard</button>
        </div>
        <button class="leave">Leave room</button>
      </div>`;

    wrap.querySelector('.close')?.addEventListener('click', () => {
      this.expanded = false;
      this.render();
    });
    // Drag the panel by its header, so the rest of the panel stays clickable.
    this.makeDraggable(wrap.querySelector('.head'));
    wrap.querySelector('.leave')?.addEventListener('click', () => this.cbs.onLeave());
    wrap.querySelector('.dash')?.addEventListener('click', () => this.cbs.onOpenDashboard());
    wrap.querySelector('.reselect')?.addEventListener('click', () => {
      this.expanded = false; // collapse so the picker overlay is unobstructed
      this.render();
      this.cbs.onReselectVideo();
    });
    // Delegated: the roster is re-rendered in place when people come and go.
    wrap.querySelector('[data-f="roster"]')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest?.('.mk') as HTMLElement | null;
      const uid = btn?.dataset.uid;
      if (!btn || !uid) return;
      btn.textContent = 'Handing over…';
      this.cbs.onTransferHost(uid);
    });
    wrap.querySelector('.retry')?.addEventListener('click', (e) => {
      this.cbs.onRetry();
      const btn = e.currentTarget as HTMLButtonElement;
      btn.textContent = 'Retrying…';
      setTimeout(() => (btn.textContent = 'Retry'), 2500);
    });
    wrap.querySelector('.resync')?.addEventListener('click', () => {
      // Show the real outcome, reported back by the controller — not an
      // assumed success. setResyncStatus() restores the label afterwards.
      this.setResyncStatus('Syncing…');
      this.cbs.onResync();
    });
    wrap.querySelector('.chat-toggle')?.addEventListener('click', () => {
      this.chatOpen = !this.chatOpen;
      // Opening the transcript is what counts as reading it.
      if (this.chatOpen) this.unread = 0;
      this.render();
      if (this.chatOpen) {
        wrap.querySelector<HTMLInputElement>('.chat-input')?.focus();
      }
    });

    const form = wrap.querySelector<HTMLFormElement>('.composer');
    const input = wrap.querySelector<HTMLInputElement>('.chat-input');
    if (input && this.draft) input.value = this.draft;
    input?.addEventListener('input', () => {
      this.draft = input.value;
    });
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input?.value.trim() ?? '';
      if (!text) return;
      this.cbs.onSend(text);
      this.draft = '';
      if (input) input.value = '';
    });
    // Streaming sites bind global hotkeys (space = play/pause, arrows = seek).
    // Keep our typing from reaching them.
    input?.addEventListener('keydown', (e) => e.stopPropagation());

    // Delegated: the message list is re-rendered on every update, so the
    // listener is bound to the container rather than to individual buttons.
    wrap.querySelector('.messages')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement)?.closest?.('.ts') as HTMLElement | null;
      if (!btn) return;
      const seconds = Number(btn.dataset.s);
      if (!Number.isFinite(seconds)) return;
      this.cbs.onSeek(seconds);
      btn.classList.add('jumped');
      setTimeout(() => btn.classList.remove('jumped'), 700);
    });

    if (this.chatOpen) this.renderMessages(wrap);
  }
}

/**
 * Matches timestamps people actually type in chat: `4:20`, `04:20`, `1:02:03`.
 * Bounded by non-digits so it won't chop into a longer number.
 */
const TIMESTAMP_RE = /(?<![\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g;

/** Convert `mm:ss` / `hh:mm:ss` to seconds, or null if the parts are invalid. */
function parseTimestamp(text: string): number | null {
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  // Reject things like 9:75 that merely look like a timestamp.
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Render a message body, turning in-range timestamps into jump buttons.
 *
 * Each literal segment is escaped individually so the markup we inject can't be
 * spoofed by message text. A timestamp beyond the video's length (or when the
 * duration isn't known yet) stays plain text.
 */
function renderBody(text: string, duration: number): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP_RE)) {
    const raw = match[1];
    const at = match.index ?? 0;
    out += esc(text.slice(last, at));
    const seconds = parseTimestamp(raw);
    const inRange = seconds !== null && duration > 0 && seconds <= duration;
    out += inRange
      ? `<button class="ts" data-s="${seconds}" title="Jump to ${esc(raw)}">${esc(raw)}</button>`
      : esc(raw);
    last = at + raw.length;
  }
  out += esc(text.slice(last));
  return out;
}

/** Emoji offered by the quick-reaction button. */
const REACTIONS = ['😂', '❤️', '🔥', '😮', '😢', '👏', '👍', '🎉'];

/**
 * A message counts as a reaction when it is nothing but emoji. Reactions are
 * ordinary encrypted chat messages — this only decides whether to also flash a
 * popup, so a false negative just means it appears in chat like any message.
 */
function isReaction(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 12) return false;
  try {
    return /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️])+$/u.test(t);
  } catch {
    return false; // engine without Unicode property escapes
  }
}

/**
 * The host's "hand over to…" roster. Kept separate from the panel template so
 * it can be patched in place when someone joins or leaves — rebuilding the
 * whole panel would wipe a half-typed chat message.
 */
function membersHtml(i: RoomInfo): string {
  const others = i.memberList.filter((m) => !m.isHost);
  if (others.length === 0) {
    return `<div class="members-h">Watching</div><div class="members-none">Nobody else here yet</div>`;
  }
  return (
    `<div class="members-h">Hand host to…</div>` +
    others
      .map(
        (m) =>
          `<button class="mk" data-uid="${esc(m.uid)}" title="Make ${esc(m.name)} the host">${esc(m.name)}</button>`,
      )
      .join('')
  );
}

/** "owner" is the internal term; the UI says HOST everywhere. */
function roleLabel(role: RoomInfo['role']): string {
  return role === 'owner' ? 'HOST' : 'VIEWER';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const CSS = `
:host, * { box-sizing: border-box; }
.wrap { font-family: system-ui, -apple-system, sans-serif; }
.hide { display: none !important; }

/* --- collapsed row: reaction button + pill --------------------------------- */
.pillrow { display: flex; align-items: center; gap: 7px; }

.react {
  width: 34px; height: 34px; flex-shrink: 0;
  border: none; border-radius: 50%;
  background: rgba(20,20,30,0.94); color: #fff;
  font-size: 16px; line-height: 1; cursor: pointer;
  box-shadow: 0 6px 22px rgba(0,0,0,0.45);
}
.react:hover { background: #2a2a3d; }

.picker {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
  margin-bottom: 8px; padding: 7px;
  background: rgba(20,20,30,0.97); border: 1px solid #33334a;
  border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
}
.emoji {
  border: none; border-radius: 8px; background: transparent;
  font-size: 19px; line-height: 1; padding: 6px; cursor: pointer;
}
.emoji:hover { background: rgba(108,92,231,.35); transform: scale(1.12); }

/* --- incoming reaction popups --------------------------------------------- */
.toasts {
  position: absolute; bottom: 100%; right: 0; margin-bottom: 10px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  pointer-events: none;
}
.toast {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px 7px 10px; border-radius: 999px;
  background: rgba(20,20,30,0.95); border: 1px solid #33334a;
  box-shadow: 0 6px 20px rgba(0,0,0,0.45);
  animation: pop .26s cubic-bezier(.2,1.3,.4,1);
  white-space: nowrap;
}
.toast.out { opacity: 0; transform: translateY(-6px); transition: all .26s ease; }
.t-emoji { font-size: 19px; line-height: 1; }
.t-who { font: 600 11px/1 system-ui, sans-serif; color: #b9aefc; }
@keyframes pop {
  from { opacity: 0; transform: translateY(8px) scale(.85); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.pill {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; border: none; border-radius: 999px;
  background: rgba(20,20,30,0.94); color: #fff;
  font: 600 13px/1 system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  backdrop-filter: blur(6px);
}
.pill:hover { background: #2a2a3d; }
.pill-text { white-space: nowrap; }
.count {
  background: #6c5ce7; border-radius: 999px;
  padding: 2px 7px; font-size: 11px; font-weight: 700;
}
/* Role chip on the collapsed pill, so host/viewer is visible without expanding. */
.role {
  font-size: 9px; font-weight: 800; letter-spacing: .6px;
  padding: 3px 6px; border-radius: 4px; flex-shrink: 0;
}
.role.owner { background: rgba(108,92,231,.32); color: #c3b9ff; }
.role.viewer { background: rgba(46,204,113,.24); color: #7fe0a6; }
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #9a9ab0; flex-shrink: 0;
}
.dot.playing { background: #2ecc71; box-shadow: 0 0 0 3px rgba(46,204,113,0.22); }

.panel {
  width: 232px; padding: 14px;
  transition: width .16s ease;
  background: rgba(20,20,30,0.97); color: #f2f2f7;
  border: 1px solid #33334a; border-radius: 12px;
  box-shadow: 0 10px 34px rgba(0,0,0,0.5);
  backdrop-filter: blur(8px);
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title {
  font-size: 13px; font-weight: 700; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.close {
  background: none; border: none; color: #9a9ab0;
  font-size: 19px; line-height: 1; cursor: pointer; padding: 0 2px;
}
.close:hover { color: #fff; }

.rows { margin-top: 10px; display: grid; gap: 6px; }
.row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.k { color: #9a9ab0; }
.v { font-weight: 600; }
.badge {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .4px; padding: 2px 7px; border-radius: 999px;
}
.badge.owner { background: rgba(108,92,231,.28); color: #b9aefc; }
.badge.viewer { background: rgba(46,204,113,.22); color: #7fe0a6; }

.hint { margin-top: 10px; font-size: 11px; color: #9a9ab0; line-height: 1.4; }
.muted { color: #9a9ab0; font-size: 12px; }
.err {
  margin-top: 10px; padding: 8px 9px; border-radius: 7px; font-size: 11px;
  background: rgba(231,76,108,.15); color: #f2a3b5;
  border: 1px solid rgba(231,76,108,.35); line-height: 1.4;
}
.retry {
  display: block; margin-top: 7px; padding: 6px 10px;
  border: 1px solid rgba(231,76,108,.5); border-radius: 6px;
  background: rgba(231,76,108,.2); color: #ffd3dd;
  font: 600 11px/1 system-ui, sans-serif; cursor: pointer;
}
.retry:hover { background: rgba(231,76,108,.35); }

/* Chat makes the panel meaningfully bigger so the transcript is readable. */
.panel.with-chat { width: 330px; }

.chat { margin-top: 12px; border-top: 1px solid #33334a; padding-top: 10px; }
.messages {
  height: 260px; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 7px;
  padding-right: 4px;
}
.messages::-webkit-scrollbar { width: 6px; }
.messages::-webkit-scrollbar-thumb { background: #3d3d55; border-radius: 3px; }

.msg { font-size: 12px; line-height: 1.35; word-break: break-word; }
.msg .who { color: #b9aefc; font-weight: 700; margin-right: 5px; }
.msg.mine .who { color: #7fe0a6; }
.msg .body { color: #e8e8f0; }

/* Clickable timestamp inside a message. */
.ts {
  display: inline; padding: 1px 5px; margin: 0 1px;
  border: 1px solid rgba(108,92,231,.55); border-radius: 4px;
  background: rgba(108,92,231,.22); color: #c9c0ff;
  font: 600 11px/1.3 ui-monospace, Menlo, monospace;
  cursor: pointer; vertical-align: baseline;
}
.ts:hover { background: rgba(108,92,231,.45); color: #fff; }
.ts.jumped { background: rgba(46,204,113,.4); border-color: rgba(46,204,113,.6); color: #fff; }
.empty-chat { color: #9a9ab0; font-size: 12px; text-align: center; padding: 16px 0; }

.composer { display: flex; gap: 6px; margin-top: 9px; }
.chat-input {
  flex: 1; min-width: 0; padding: 8px 10px;
  border: 1px solid #33334a; border-radius: 8px;
  background: #262636; color: #f2f2f7;
  font: 400 12px/1 system-ui, sans-serif;
}
.chat-input:focus { outline: none; border-color: #6c5ce7; }
.send {
  border: none; border-radius: 8px; background: #6c5ce7; color: #fff;
  padding: 0 12px; cursor: pointer; font-size: 12px;
}
.send:hover { background: #7d6ef0; }

/* --- unread indicator ------------------------------------------------------ */
.pillrow { position: relative; }
.unread {
  position: absolute; top: -6px; right: -6px;
  min-width: 19px; height: 19px; padding: 0 5px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; background: #e74c6c; color: #fff;
  font: 800 10px/1 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0,0,0,.4);
  pointer-events: none;
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(231,76,108,.65), 0 2px 8px rgba(0,0,0,.4); }
  50%      { box-shadow: 0 0 0 7px rgba(231,76,108,0),  0 2px 8px rgba(0,0,0,.4); }
}
/* Respect users who ask for reduced motion — keep the badge, drop the pulse. */
@media (prefers-reduced-motion: reduce) {
  .unread { animation: none; }
}

.tbadge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 17px; height: 17px; margin-left: 6px; padding: 0 5px;
  border-radius: 999px; background: #e74c6c; color: #fff;
  font: 800 10px/1 system-ui, sans-serif;
}

/* Drag handles */
.pill { cursor: grab; }
.pill:active { cursor: grabbing; }
.head { cursor: grab; user-select: none; }
.head:active { cursor: grabbing; }

.reselect {
  width: 100%; margin-top: 8px; padding: 9px;
  border: 1px solid rgba(46,204,113,.5); border-radius: 8px;
  background: rgba(46,204,113,.16); color: #8fe6b0;
  font: 600 12px/1 system-ui, sans-serif; cursor: pointer;
}
.reselect:hover { background: rgba(46,204,113,.3); }

.members { margin-top: 10px; border-top: 1px solid #33334a; padding-top: 9px; }
.members-h {
  font-size: 10px; font-weight: 700; letter-spacing: .5px;
  text-transform: uppercase; color: #9a9ab0; margin-bottom: 6px;
}
.mk {
  display: block; width: 100%; margin-bottom: 5px; padding: 7px 9px;
  border: 1px solid #33334a; border-radius: 7px;
  background: #262636; color: #f2f2f7;
  font: 600 11px/1 system-ui, sans-serif; cursor: pointer;
  text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mk:hover { background: rgba(108,92,231,.35); border-color: rgba(108,92,231,.6); }
.members-none { font-size: 11px; color: #9a9ab0; }

.resync {
  width: 100%; margin-top: 12px; padding: 9px;
  border: 1px solid rgba(108,92,231,.55); border-radius: 8px;
  background: rgba(108,92,231,.18); color: #c3b9ff;
  font: 600 12px/1 system-ui, sans-serif; cursor: pointer;
}
.resync:hover { background: rgba(108,92,231,.32); }

.actions { display: flex; gap: 8px; margin-top: 8px; }
.chat-toggle, .dash, .leave {
  padding: 9px; border: none; border-radius: 8px;
  font: 600 12px/1 system-ui, sans-serif; cursor: pointer;
}
.chat-toggle, .dash {
  flex: 1; background: #262636; color: #f2f2f7; border: 1px solid #33334a;
  white-space: nowrap;
}
.chat-toggle:hover, .dash:hover { background: #2f2f44; }
.leave { width: 100%; margin-top: 8px; background: #e74c6c; color: #fff; }
.leave:hover { background: #f25d7c; }
`;
