import { onAuthStateChanged } from 'firebase/auth';
import { getDocs, collection, type Unsubscribe } from 'firebase/firestore';
import { auth, db } from '../firebase/config';
import { getProfile } from '../firebase/auth';
import {
  getRoom,
  watchRoom,
  writePlayback,
  touchRoom,
  setOwner,
  transferOwnership,
  updateRoomVideo,
} from '../firebase/rooms';
import {
  joinRoom,
  leaveRoom,
  heartbeat,
  watchMembers,
  reconcileOwnership,
  freshnessRef,
  isFresh,
  serverNow,
} from '../firebase/presence';
import { COLLECTIONS, ROOM_TOUCH_MS, CHAT_MAX_LEN, HEARTBEAT_MS } from '../shared/constants';
import { ext } from '../shared/ext';
import { recordAttendance } from '../firebase/history';
import { sendMessage, watchMessages } from '../firebase/chat';
import { importRoomKey, deriveKeyFromPassphrase, checkVerifier } from '../shared/crypto';
import { log, warn, fail } from '../shared/log';
import type { ChatMessage, Member, MemberRole, Room, UserProfile } from '../shared/types';
import {
  PORT_NAME,
  PENDING_PICK_KEY,
  type PopupRequest,
  type PopupResponse,
  type ContentToBg,
  type BgToContent,
  type AttachState,
  type PendingPick,
  type RoomInfo,
} from '../shared/messages';

// ===========================================================================
// The background service worker owns everything realtime: the authenticated
// Firebase session (shared with the popup), Firestore subscriptions, playback
// writes and presence. The content script is pure DOM and talks to us over a
// long-lived port.
// ===========================================================================

interface Session {
  roomId: string;
  selector: string;
  role: MemberRole;
  tabId: number;
  /** Origin of the frame holding the video ('' = top document). */
  frameOrigin: string;
  /** Key of the frame we're currently attached to, once it has connected. */
  frameKey: string | null;
  /** Whether an attaching owner publishes its position or adopts the room's. */
  ownerMode: 'publish' | 'adopt';
  me: UserProfile;
}

/** One connected content script — there is one per frame, not per tab. */
interface FrameConn {
  port: chrome.runtime.Port;
  tabId: number;
  frameId: number;
  origin: string;
  isTop: boolean;
}

const frameKey = (tabId: number, frameId: number) => `${tabId}:${frameId}`;

let session: Session | null = null;
let currentRoom: Room | null = null;
let unsubRoom: Unsubscribe | null = null;
let unsubMembers: Unsubscribe | null = null;
let unsubChat: Unsubscribe | null = null;
/** Chat key for the active room; derived (private) or imported (public). */
let chatKey: CryptoKey | null = null;

const passKey = (roomId: string) => `watchparty:pass:${roomId}`;

/**
 * Resolve the room's chat key.
 *  • public  — import the key stored on the room.
 *  • private — derive it from the passphrase (given now, or cached in session
 *    storage from an earlier join) and validate it against the room's verifier.
 * Returns null when a private room's passphrase is missing or wrong.
 */
async function resolveChatKey(room: Room, passphrase?: string): Promise<CryptoKey | null> {
  if (room.visibility !== 'private') {
    if (!room.chatKey) return null;
    return importRoomKey(room.chatKey).catch(() => null);
  }
  let pass = passphrase?.trim();
  if (!pass) {
    const stored = await ext.storage.session.get(passKey(room.id));
    pass = stored[passKey(room.id)];
  }
  if (!pass) return null;
  const key = await deriveKeyFromPassphrase(pass, room.chatSalt).catch(() => null);
  if (!key || !(await checkVerifier(key, room.chatCheck))) return null;
  // Cache only for this browser session so a rejoin doesn't re-prompt.
  await ext.storage.session.set({ [passKey(room.id)]: pass });
  return key;
}
let lastError: string | null = null;
let lastPlaybackWrite = 0;
/** Minimum gap between playback writes for non-transport (seek/rate) events. */
const PLAYBACK_THROTTLE_MS = 150;
/**
 * The most recent seek/rate event held back by the throttle. It is DEFERRED,
 * never dropped: a scrub emits a burst of `seeked` events and the final one is
 * the position that matters, and because sync is event-driven (no periodic
 * republish — see DECISIONS.md #10) a dropped final seek leaves every viewer
 * parked at an intermediate position until the host next acts.
 */
let pendingPlayback: { currentTime: number; isPlaying: boolean; rate: number } | null = null;
let playbackFlushTimer: ReturnType<typeof setTimeout> | undefined;
let lastRoomTouch = 0;
/** When the current session started, for the post-join settle window. */
let sessionStartedAt = 0;
/** Media length reported by the video frame; 0 until metadata loads. */
let videoDuration = 0;
/** No ownership handoff for this long after joining. */
const JOIN_GRACE_MS = 4000;
/** Identity of the last playback state pushed to the viewer. */
let lastAppliedSig = '';

/** Changes only when playback genuinely changes — not on liveness writes. */
function playbackSignature(room: Room): string {
  const p = room.playback;
  return [p?.updatedAt?.toMillis?.() ?? 0, p?.isPlaying, p?.currentTime, p?.rate].join('|');
}
/** Live member count, kept so ROOM_INFO can be sent from either subscription. */
let liveMemberCount = 0;
/** Latest members snapshot, so the count can be re-aged without a new snapshot. */
let lastMembers: Member[] = [];
/** Fresh members from the last server snapshot, for the widget's host-transfer list. */
let presentMembers: Member[] = [];
/** Drives presence writes and periodic re-aging of the watcher count. */
let presenceTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Recompute the watcher count from the cached snapshot using the estimated
 * server clock. Runs on a timer as well as on snapshots: if every member stops
 * heartbeating, no snapshot arrives, and without this the displayed count would
 * freeze at its last value indefinitely.
 */
/**
 * Presence writes run here rather than in the content script. Chrome throttles
 * `setInterval` in hidden tabs to about once a minute after ~5 minutes, so a
 * viewer who switched tabs would go "stale", vanish from the watcher count, and
 * could even trigger a spurious ownership handoff. Service-worker timers aren't
 * subject to tab throttling.
 */
function startPresenceTimer() {
  stopPresenceTimer();
  presenceTimer = setInterval(async () => {
    const s = session;
    if (!s) return;
    await heartbeat(s.roomId, s.me.uid);
    // The owner also stamps the ROOM's liveness, so a room expires on its own
    // if every client vanishes without a clean leave.
    if (s.role === 'owner' && Date.now() - lastRoomTouch > ROOM_TOUCH_MS) {
      lastRoomTouch = Date.now();
      await touchRoom(s.roomId).catch((e) => warn('bg', 'touchRoom failed', e));
    }
    recountWatchers();
  }, HEARTBEAT_MS);
}

function stopPresenceTimer() {
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = undefined;
}

function recountWatchers() {
  const now = serverNow();
  const next = lastMembers.filter((m) => isFresh(m, now)).length;
  if (next !== liveMemberCount) {
    liveMemberCount = next;
    pushRoomInfo();
  }
}

/**
 * Latest decrypted chat, cached so it can be re-sent to a top frame that
 * connects *after* the Firestore snapshot arrived. Joining navigates the tab,
 * so the first snapshot routinely lands before the new page's content script
 * exists — without this replay the widget stayed empty until the next message
 * changed the collection.
 */
let lastMessages: ChatMessage[] = [];

function pushChat() {
  const s = session;
  if (!s || lastMessages.length === 0) return;
  broadcastToTopFrame(s.tabId, { t: 'CHAT', messages: lastMessages });
}

/** Push the current room state to the on-page widget. */
function pushRoomInfo() {
  const s = session;
  if (!s || !currentRoom) return;
  const info: RoomInfo = {
    name: currentRoom.name,
    ownerName: currentRoom.ownerName,
    myUid: s.me.uid,
    role: s.role,
    members: liveMemberCount,
    isPlaying: !!currentRoom.playback?.isPlaying,
    duration: videoDuration,
    memberList: presentMembers.map((m) => ({
      uid: m.uid,
      name: m.displayName,
      isHost: m.uid === currentRoom!.ownerUid,
    })),
    error: lastError,
  };
  broadcastToTopFrame(s.tabId, { t: 'ROOM_INFO', info });
}
// Member uids seen on the previous snapshot, to detect fresh joiners.
let knownMembers = new Set<string>();
// Tabs we're intentionally navigating (join flow). Their content port will
// disconnect as the old page unloads — that must NOT be treated as leaving the
// room; we're about to re-attach on the new page.
const pendingNav = new Set<number>();
// Frames that armed a picker overlay for the current pick request, so we can
// tell "no video anywhere in this tab" from "the user is still choosing".
let pickArmed = 0;
let pickTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * What the current pick is for: creating a brand-new room, or repointing the
 * active room at a different video (host switched episode/source).
 */
let pickMode: 'create' | 'reselect' = 'create';
/** Identity of the room's video, to notice when the host repoints it. */
let lastVideoSig = '';

const videoSignature = (room: Room) =>
  `${room.pageUrl}|${room.selector}|${room.frameOrigin}`;

// Keyed by `tabId:frameId` — a tab has many frames, and keying by tab alone
// meant a later frame silently overwrote the earlier one.
const ports = new Map<string, FrameConn>();

const framesInTab = (tabId: number) => [...ports.values()].filter((f) => f.tabId === tabId);

function clearPickTimer() {
  if (pickTimer) clearTimeout(pickTimer);
  pickTimer = undefined;
}

/** The frame in `tabId` whose origin matches the room's ('' = the top frame). */
function findFrame(tabId: number, origin: string): FrameConn | undefined {
  const frames = framesInTab(tabId);
  if (!origin) return frames.find((f) => f.isTop);
  return frames.find((f) => f.origin === origin);
}

// --- auth readiness --------------------------------------------------------

let authReady: Promise<void> | null = null;
function whenAuthReady(): Promise<void> {
  if (!authReady) {
    authReady = new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, () => {
        unsub();
        resolve();
      });
    });
  }
  return authReady;
}

async function getMe(): Promise<UserProfile | null> {
  await whenAuthReady();
  const user = auth.currentUser;
  if (!user) return null;
  return getProfile(user.uid);
}

// --- session persistence (survives SW recycling) ---------------------------

async function persistSession() {
  // frameKey is deliberately NOT persisted — frame ids don't survive a reload,
  // so the frame is re-resolved from frameOrigin when it announces itself.
  const snapshot = session
    ? {
        roomId: session.roomId,
        selector: session.selector,
        role: session.role,
        tabId: session.tabId,
        frameOrigin: session.frameOrigin,
      }
    : null;
  await ext.storage.session.set({ 'watchparty:session': snapshot });
}

async function rehydrate() {
  const { ['watchparty:session']: snap } = await ext.storage.session.get('watchparty:session');
  if (!snap) return;
  const me = await getMe();
  if (!me) {
    await ext.storage.session.remove('watchparty:session');
    return;
  }
  await startSession(snap.roomId, snap.role as MemberRole, snap.tabId, me, { rejoin: true });
}

// --- core session lifecycle ------------------------------------------------

async function startSession(
  roomId: string,
  role: MemberRole,
  tabId: number,
  me: UserProfile,
  opts: { rejoin?: boolean; ownerMode?: 'publish' | 'adopt'; passphrase?: string } = {},
): Promise<PopupResponse> {
  const room = await getRoom(roomId);
  if (!room || !room.isActive) {
    lastError = 'This room is no longer active.';
    return { ok: false, error: lastError };
  }

  // A private room can't be entered without the passphrase — it's the only way
  // to read the chat, so there's nothing to join without it.
  const key = await resolveChatKey(room, opts.passphrase);
  if (room.visibility === 'private' && !key) {
    return { ok: false, error: opts.passphrase ? 'PASSPHRASE_INVALID' : 'PASSPHRASE_REQUIRED' };
  }
  chatKey = key;

  // Re-entering the room we're already in must NOT go through the leave path:
  // teardownSession({leave:true}) deletes our member doc and then runs
  // deactivateIfEmpty(), so a lone host who pressed "Join" on their own room
  // (the dashboard lists every live room, theirs included) deactivated it — and
  // was then detached by the inactive-room snapshot that followed.
  const reentering = session?.roomId === roomId;
  await teardownSession({ leave: !reentering });

  // The room's primary owner reclaims control on return. Automatic handoff
  // (someone left) never moves the primary claim, so a host who refreshes or
  // steps away gets their room back. A deliberate transfer DOES move the claim,
  // so this won't undo one.
  let effectiveRole = role;
  if (room.primaryOwnerUid === me.uid && room.ownerUid !== me.uid) {
    log('bg', 'primary owner returned → reclaiming host', `room=${roomId}`);
    await setOwner(roomId, me.uid, me.displayName).catch((e) =>
      warn('bg', 'reclaim failed', e),
    );
    effectiveRole = 'owner';
  }

  session = {
    roomId,
    selector: room.selector,
    role: effectiveRole,
    tabId,
    frameOrigin: room.frameOrigin ?? '',
    frameKey: null,
    // Default to adopting: only a freshly created room says 'publish'.
    ownerMode: opts.ownerMode ?? 'adopt',
    me,
  };
  currentRoom = room;
  lastError = null;
  knownMembers = new Set();
  lastAppliedSig = ''; // force the first APPLY of a new session
  // Reset the watcher count, or the previous room's number shows briefly on the
  // widget before the first members snapshot lands.
  liveMemberCount = 0;
  lastMembers = [];
  sessionStartedAt = Date.now();
  videoDuration = 0; // re-reported by the new video frame on attach
  presentMembers = [];
  lastVideoSig = videoSignature(room); // baseline: don't treat this as a change
  startPresenceTimer();
  await persistSession();
  // effectiveRole, not the requested role: a returning primary owner has just
  // reclaimed the room above, and writing 'viewer' here would leave the member
  // doc contradicting rooms/{id}.ownerUid.
  await joinRoom(roomId, me, effectiveRole).catch(() => undefined);
  // Stamp this room in the user's own history, so it appears under "last
  // attended" and can be favourited later.
  void recordAttendance(me.uid, room);

  subscribe();
  // If the content script for this tab is already connected (owner is on the
  // page, or the SW was rehydrated), attach immediately. Otherwise the ATTACH
  // is sent when the tab's content sends HELLO after (re)loading.
  attachTab(tabId);
  return { ok: true };
}

function subscribe() {
  const s = session;
  if (!s) return;

  unsubRoom = watchRoom(s.roomId, (room) => {
    if (!room || !room.isActive) {
      // Room closed (last member left / deactivated) — detach locally.
      broadcastToTab(s.tabId, { t: 'DETACH' });
      broadcastToTopFrame(s.tabId, { t: 'WIDGET_OFF' });
      void teardownSession({ leave: false });
      return;
    }
    currentRoom = room;

    // The host may have repointed the room at a different video. Follow it:
    // navigate if it's on another page, otherwise just re-attach to the new
    // selector in place.
    const sig = videoSignature(room);
    if (lastVideoSig && sig !== lastVideoSig) {
      log('bg', 'room video changed → following', room.pageUrl.slice(0, 70));
      s.selector = room.selector;
      s.frameOrigin = room.frameOrigin ?? '';
      s.frameKey = null;
      lastAppliedSig = ''; // the new video's playback is a fresh start
      lastVideoSig = sig;
      void persistSession();
      void followRoomVideo(s.tabId, room);
      return;
    }
    lastVideoSig = sig;

    // Role may have changed via an ownership handoff.
    const newRole: MemberRole = room.ownerUid === s.me.uid ? 'owner' : 'viewer';
    if (newRole !== s.role) {
      log('bg', `role handoff ${s.role} → ${newRole}`, `owner=${room.ownerName}`);
      s.role = newRole;
      void persistSession();
      broadcastToTab(s.tabId, { t: 'SET_ROLE', role: newRole });
    }

    // Viewers mirror the owner's playback. The owner is the source of truth and
    // never applies remote state to itself.
    if (s.role === 'viewer') {
      // Only push when playback ACTUALLY changed. The room doc also mutates on
      // the 9s `lastActiveAt` liveness heartbeat, and re-applying an unchanged
      // (and by then stale) anchor is what yanked viewers back on a timer.
      const sig = playbackSignature(room);
      if (sig === lastAppliedSig) {
        pushRoomInfo();
        return;
      }
      lastAppliedSig = sig;
      const attached = !!s.frameKey && ports.has(s.frameKey);
      log(
        'bg',
        'room snapshot → APPLY',
        `t=${room.playback.currentTime?.toFixed?.(2)}`,
        `playing=${room.playback.isPlaying}`,
        attached ? `frame=${s.frameKey}` : '⚠ NOT ATTACHED to any frame yet',
      );
      broadcastToTab(s.tabId, { t: 'APPLY', playback: room.playback });
    }

    pushRoomInfo();
  });

  // Chat is decrypted here, in the extension context — the content script never
  // sees the room key, only plaintext for rendering.
  if (chatKey) {
    unsubChat = watchMessages(
      s.roomId,
      chatKey,
      (messages) => {
        if (!session) return;
        log('bg', `chat snapshot → ${messages.length} message(s)`);
        lastMessages = messages;
        pushChat();
      },
      (err) => {
        fail('bg', 'chat subscription FAILED — is the messages rule deployed?', err);
        lastError = 'Chat unavailable (permission denied). Deploy firestore.rules.';
        pushRoomInfo();
      },
    );
  } else {
    warn('bg', 'no chat key for this room — chat disabled');
  }

  unsubMembers = watchMembers(s.roomId, async (members, fromCache) => {
    if (!currentRoom || !session) return;

    // When a new viewer joins, ping the owner's content script to publish its
    // live seek/play state so the joiner resumes from where the owner is now.
    if (session.role === 'owner') {
      const joined = members.some((m) => m.uid !== session!.me.uid && !knownMembers.has(m.uid));
      if (joined) {
        log('bg', 'new member joined → REQUEST_STATE to owner', `members=${members.length}`);
        broadcastToTab(session.tabId, { t: 'REQUEST_STATE' });
      }
    }
    knownMembers = new Set(members.map((m) => m.uid));

    lastMembers = members;
    const ref = freshnessRef(members); // recalibrates the clock estimate
    const fresh = members.filter((m) => isFresh(m, ref));
    liveMemberCount = fresh.length;
    if (!fromCache) presentMembers = fresh;
    pushRoomInfo();

    // Ownership decisions require an authoritative, server-confirmed view.
    // A cached snapshot right after joining contains only our own pending
    // write, which previously made a joiner promote itself to host.
    if (fromCache) {
      log('bg', 'skipping ownership reconcile — cached snapshot');
      return;
    }
    // Second guard: give the room a moment to settle after we join, so a
    // momentarily-incomplete member list can't trigger a handoff.
    if (Date.now() - sessionStartedAt < JOIN_GRACE_MS) return;

    try {
      await reconcileOwnership(currentRoom, members, session.me);
    } catch {
      /* transient permission/race errors are expected; next tick retries */
    }
  });
}

/**
 * Bring a tab onto the room's current video. Used when the host repoints the
 * room and when a viewer asks to re-sync after the page has changed.
 */
async function followRoomVideo(tabId: number, room: Room) {
  const tab = await ext.tabs.get(tabId).catch(() => undefined);
  const samePage = tab?.url === room.pageUrl;
  broadcastToTab(tabId, { t: 'DETACH' }); // stop controlling the old element
  if (samePage) {
    attachTab(tabId);
    return;
  }
  // Navigating closes the content ports; mark it so that isn't read as leaving.
  pendingNav.add(tabId);
  setTimeout(() => pendingNav.delete(tabId), 20000);
  await ext.tabs.update(tabId, { url: room.pageUrl }).catch((e) =>
    warn('bg', 'could not navigate to the room video', e),
  );
}

async function teardownSession(opts: { leave: boolean }) {
  stopPresenceTimer();
  clearPendingPlayback();
  unsubRoom?.();
  unsubMembers?.();
  unsubChat?.();
  unsubRoom = unsubMembers = unsubChat = null;
  lastMembers = [];
  lastMessages = [];
  liveMemberCount = 0;
  const s = session;
  session = null;
  currentRoom = null;
  await ext.storage.session.remove('watchparty:session');
  if (s && opts.leave) {
    await leaveRoom(s.roomId, s.me.uid);
    await deactivateIfEmpty(s.roomId);
  }
}

/** If no members remain after we leave, mark the room inactive. */
async function deactivateIfEmpty(roomId: string) {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.rooms, roomId, COLLECTIONS.members));
    if (snap.empty) {
      const { deactivateRoom } = await import('../firebase/rooms');
      await deactivateRoom(roomId).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

// --- content port ----------------------------------------------------------

/** Attach to the frame in `tabId` that matches the room's frameOrigin. */
function attachTab(tabId: number) {
  const s = session;
  if (!s) return;
  const frame = findFrame(tabId, s.frameOrigin);
  if (!frame) {
    // The player iframe often loads after the top document; HELLO from it will
    // re-drive this once it connects.
    warn('bg', `no frame yet for origin "${s.frameOrigin || '(top)'}" in tab ${tabId}`);
    return;
  }
  s.frameKey = frameKey(frame.tabId, frame.frameId);
  log('bg', `ATTACH → frame ${s.frameKey}`, `origin=${frame.origin || '(top)'}`, `role=${s.role}`);
  frame.port.postMessage({
    t: 'ATTACH',
    roomId: s.roomId,
    selector: s.selector,
    role: s.role,
    ownerMode: s.ownerMode,
    playback: currentRoom?.playback ?? null,
  } as BgToContent);
}

/** Send to the frame we're attached to (not the whole tab). */
function broadcastToTab(_tabId: number, msg: BgToContent) {
  const key = session?.frameKey;
  if (!key) return;
  ports.get(key)?.port.postMessage(msg);
}

/**
 * Send to the tab's TOP frame. The floating widget lives there so it can float
 * over the whole page, even when the video sits in a nested player iframe.
 */
function broadcastToTopFrame(tabId: number, msg: BgToContent) {
  framesInTab(tabId)
    .find((f) => f.isTop)
    ?.port.postMessage(msg);
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  if (tabId == null || frameId == null) return;
  const key = frameKey(tabId, frameId);
  // Origin/isTop are filled in by the HELLO message that follows immediately.
  ports.set(key, { port, tabId, frameId, origin: '', isTop: frameId === 0 });

  port.onMessage.addListener((msg: ContentToBg) => handleContentMessage(key, tabId, msg));
  port.onDisconnect.addListener(() => {
    ports.delete(key);
    // A disconnect from a tab we're intentionally navigating (join flow) is
    // expected — keep the session so we can re-attach on the new page.
    if (pendingNav.has(tabId)) {
      log('bg', `frame ${key} closed during intentional nav — session kept`);
      return;
    }
    // Only the frame we're ATTACHED to counts as leaving. Sub-frames (ads,
    // trackers) come and go constantly and must not end the room.
    if (session && session.frameKey === key) {
      log('bg', `attached frame ${key} closed → leaving room`);
      void teardownSession({ leave: true });
    }
  });
});

/** Write playback as the current owner. Assumes the caller checked the role. */
async function publishPlayback(state: { isPlaying: boolean; currentTime: number; rate: number }) {
  const s = session;
  if (!s || s.role !== 'owner') return;
  lastPlaybackWrite = Date.now();
  await writePlayback(s.roomId, s.me.uid, state).catch((e) =>
    fail('bg', 'writePlayback FAILED (check firestore.rules / ownerUid)', e),
  );
}

function clearPendingPlayback() {
  if (playbackFlushTimer) clearTimeout(playbackFlushTimer);
  playbackFlushTimer = undefined;
  pendingPlayback = null;
}

/** Publish the seek/rate event held back by the throttle. */
async function flushPendingPlayback() {
  const state = pendingPlayback;
  playbackFlushTimer = undefined;
  pendingPlayback = null;
  if (!state) return;
  log('bg', 'write playback (deferred)', `t=${state.currentTime.toFixed(2)}`);
  await publishPlayback(state);
}

async function handleContentMessage(key: string, tabId: number, msg: ContentToBg) {
  switch (msg.t) {
    case 'HELLO': {
      // Record this frame's identity, then (re)attach if it's the frame our
      // session wants. Frames announce themselves as they load, so the player
      // iframe arriving late is what finally triggers ATTACH.
      const conn = ports.get(key);
      if (conn) {
        conn.origin = msg.origin;
        conn.isTop = msg.isTop;
      }
      if (session && session.tabId === tabId) {
        if (msg.isTop) {
          pendingNav.delete(tabId); // top document finished loading
          pushRoomInfo(); // (re)mount the floating widget on the new page
          pushChat(); // replay chat the widget missed while the page loaded
        }
        const wanted = session.frameOrigin;
        if ((wanted && msg.origin === wanted) || (!wanted && msg.isTop)) {
          attachTab(tabId);
        }
      }
      break;
    }

    case 'PICK_READY':
      pickArmed += 1;
      log('bg', `frame ${key} armed picker`, `(${pickArmed} frame(s) with video)`);
      break;

    case 'HEARTBEAT':
      // Presence writes are driven by the background's own timer (see
      // startPresenceTimer). This message exists only to keep the MV3 service
      // worker alive while a tab is attached — the content script's interval is
      // subject to background-tab throttling and can't be trusted for presence.
      break;

    case 'VIDEO_EVENT': {
      // Only an owner publishes playback. Throttle rapid seeks a touch.
      if (!session || session.role !== 'owner' || session.frameKey !== key) return;
      const now = Date.now();
      // Transport changes and on-demand syncs always write; only rapid seeks
      // are throttled.
      const isTransport = msg.event === 'play' || msg.event === 'pause' || msg.event === 'sync';
      const sinceLast = now - lastPlaybackWrite;
      if (!isTransport && sinceLast < PLAYBACK_THROTTLE_MS) {
        // Hold it, don't discard it — the last event of a scrub is the one the
        // viewers need, and nothing republishes it later.
        log('bg', `deferring ${msg.event} (${sinceLast}ms since last write)`);
        pendingPlayback = { isPlaying: msg.isPlaying, currentTime: msg.currentTime, rate: msg.rate };
        if (!playbackFlushTimer) {
          playbackFlushTimer = setTimeout(
            () => void flushPendingPlayback(),
            PLAYBACK_THROTTLE_MS - sinceLast,
          );
        }
        return;
      }
      // A transport change supersedes anything still queued.
      clearPendingPlayback();
      log('bg', `write playback ${msg.event}`, `t=${msg.currentTime.toFixed(2)}`, `playing=${msg.isPlaying}`);
      await publishPlayback({
        isPlaying: msg.isPlaying,
        currentTime: msg.currentTime,
        rate: msg.rate,
      });
      break;
    }

    case 'ATTACHED':
      lastError = null;
      pushRoomInfo();
      pushChat();
      break;

    case 'CHAT_SEND': {
      // Plaintext arrives from the page; it is encrypted here before it ever
      // reaches Firestore.
      if (!session || session.tabId !== tabId) return;
      if (!chatKey) {
        warn('bg', 'chat send ignored — no key for this room');
        return;
      }
      const text = msg.text.slice(0, CHAT_MAX_LEN);
      await sendMessage(session.roomId, chatKey, session.me, text).catch((e) =>
        fail('bg', 'chat send failed', e),
      );
      break;
    }

    case 'VIDEO_META':
      if (!session || session.frameKey !== key) return;
      if (msg.duration !== videoDuration) {
        videoDuration = msg.duration;
        pushRoomInfo(); // widget needs it to range-check chat timestamps
      }
      break;

    case 'SEEK_TO':
      // Timestamp clicked in the top-frame chat; the controller is in the video
      // frame. A host's jump propagates like any other host action.
      if (!session || session.tabId !== tabId) return;
      broadcastToTab(session.tabId, { t: 'SEEK', seconds: msg.seconds });
      break;

    case 'RETRY_ATTACH':
      // Sent from the top-frame widget; the controller lives in the video frame.
      if (!session || session.tabId !== tabId) return;
      lastError = null;
      pushRoomInfo();
      broadcastToTab(session.tabId, { t: 'RETRY' });
      // The player frame may have loaded since we last looked, so re-resolve it.
      attachTab(session.tabId);
      break;

    case 'RESYNC_REQUEST': {
      if (!session || session.tabId !== tabId || session.role !== 'viewer') return;
      // If the host has moved the room to a different page since we attached,
      // "sync" means go there — seeking the old video would be meaningless.
      const tab = await ext.tabs.get(tabId).catch(() => undefined);
      if (currentRoom && tab?.url !== currentRoom.pageUrl) {
        log('bg', 'resync requires navigation to the room video');
        await followRoomVideo(tabId, currentRoom);
        return;
      }
      if (!currentRoom) return;
      // How long ago the host published this state, measured on the calibrated
      // server clock. The content script can't work this out itself: its own
      // copy may be old, and comparing a server timestamp to a local clock is
      // exactly the skew bug we removed elsewhere.
      const writtenAt = currentRoom.playback?.updatedAt?.toMillis?.() ?? 0;
      const elapsedMs = writtenAt ? Math.max(0, serverNow() - writtenAt) : 0;
      log('bg', `viewer requested resync (host state is ${Math.round(elapsedMs / 1000)}s old)`);
      broadcastToTab(session.tabId, {
        t: 'RESYNC',
        playback: currentRoom.playback,
        elapsedMs,
      });
      break;
    }

    case 'RESYNC_DONE':
      // Relay the real outcome to the widget, which lives in the top frame.
      broadcastToTopFrame(tabId, { t: 'RESYNC_STATUS', text: msg.text });
      break;

    case 'TRANSFER_HOST': {
      // Only the current host may hand the room over, and only to someone else.
      if (!session || session.tabId !== tabId || session.role !== 'owner') return;
      if (msg.uid === session.me.uid) return;
      const target = presentMembers.find((m) => m.uid === msg.uid);
      if (!target) return warn('bg', 'transfer target is no longer present', msg.uid);
      log('bg', `transferring host to ${target.displayName}`);
      await transferOwnership(session.roomId, target.uid, target.displayName).catch((e) =>
        fail('bg', 'host transfer failed', e),
      );
      break;
    }

    case 'RESELECT_VIDEO': {
      // Host repointing the room at a different video: re-run the picker in
      // this tab, then update the room rather than creating a new one.
      if (!session || session.tabId !== tabId || session.role !== 'owner') return;
      const frames = framesInTab(tabId);
      if (frames.length === 0) return warn('bg', 'no frames to pick from');
      pickMode = 'reselect';
      pickArmed = 0;
      clearPickTimer();
      frames.forEach((f) => f.port.postMessage({ t: 'PICK' } as BgToContent));
      log('bg', `reselect PICK → ${frames.length} frame(s)`);
      pickTimer = setTimeout(() => {
        if (pickArmed === 0) {
          lastError = 'No playable video found on this page.';
          pushRoomInfo();
        }
      }, 1200);
      break;
    }

    case 'OPEN_DASHBOARD':
      // The content script can't open tabs itself.
      await ext.tabs
        .create({ url: ext.runtime.getURL('src/dashboard/index.html') })
        .catch((e) => warn('bg', 'could not open dashboard', e));
      break;

    case 'LEAVE': {
      // "Leave room" pressed in the widget — which lives in the TOP frame, so
      // match on the tab rather than the attached frame.
      if (!session || session.tabId !== tabId) return;
      log('bg', 'leave requested from in-page widget');
      broadcastToTab(session.tabId, { t: 'DETACH' });
      broadcastToTopFrame(tabId, { t: 'WIDGET_OFF' });
      await teardownSession({ leave: true });
      break;
    }

    case 'ATTACH_ERROR':
      if (msg.reason !== 'cancelled') {
        lastError = msg.reason;
        // Raised in the video frame — surface it on the top-frame widget.
        pushRoomInfo();
      }
      break;

    case 'PICK_RESULT':
      await onPickResult(tabId, msg);
      break;

    case 'PICK_ERROR':
      if (msg.reason !== 'cancelled') lastError = msg.reason;
      await ext.action.setBadgeText({ text: '' }).catch(() => undefined);
      break;
  }
}

async function onPickResult(tabId: number, msg: Extract<ContentToBg, { t: 'PICK_RESULT' }>) {
  clearPickTimer();
  // Every frame holding a video armed an overlay, but only one of them was
  // clicked. The rest must be told to stand down — their overlay is fixed and
  // full-viewport and swallows every click in that frame, so a page whose top
  // document has its own <video> alongside an embedded player became
  // unclickable once the user picked inside the iframe.
  framesInTab(tabId).forEach((f) => f.port.postMessage({ t: 'PICK_CANCEL' } as BgToContent));
  // A picked video inside an iframe reports that FRAME's url/title. Viewers must
  // navigate to the top-level page instead, so take it from the tab. Embed URLs
  // also carry per-session tokens, so we persist only the frame's origin.
  const tab = await ext.tabs.get(tabId).catch(() => undefined);

  // Reselect: update the existing room in place so every viewer follows, rather
  // than creating a second room.
  if (pickMode === 'reselect') {
    pickMode = 'create';
    const s = session;
    if (!s || s.role !== 'owner') return;
    const pageUrl = tab?.url ?? msg.frameUrl;
    const frameOrigin = msg.isTop ? '' : msg.frameOrigin;
    log('bg', 'reselect → updating room video', { pageUrl: pageUrl?.slice(0, 60) });
    await updateRoomVideo(s.roomId, s.me.uid, {
      pageUrl,
      selector: msg.selector,
      frameOrigin,
      currentTime: msg.currentTime,
    }).catch((e) => fail('bg', 'could not update the room video', e));
    // Re-attach locally to the newly chosen element. Viewers pick the change up
    // from the room snapshot and follow via followRoomVideo().
    s.selector = msg.selector;
    s.frameOrigin = frameOrigin;
    s.frameKey = null;
    s.ownerMode = 'publish'; // this player is the truth for the new video
    lastVideoSig = `${pageUrl}|${msg.selector}|${frameOrigin}`;
    await persistSession();
    attachTab(tabId);
    return;
  }
  const pending: PendingPick = {
    selector: msg.selector,
    currentTime: msg.currentTime,
    pageUrl: tab?.url ?? msg.frameUrl,
    pageTitle: tab?.title ?? '',
    frameOrigin: msg.isTop ? '' : msg.frameOrigin,
  };
  log('bg', 'pick captured', {
    frame: msg.isTop ? '(top)' : msg.frameOrigin,
    pageUrl: pending.pageUrl?.slice(0, 60),
    selector: msg.selector,
  });
  await ext.storage.local.set({ [PENDING_PICK_KEY]: pending, 'watchparty:pickTab': tabId });
  await ext.action.setBadgeText({ text: '1' }).catch(() => undefined);
  await ext.action.setBadgeBackgroundColor({ color: '#6c5ce7' }).catch(() => undefined);
  // Best-effort: pop the popup open so the user can name & save the room.
  try {
    await ext.action.openPopup();
  } catch {
    /* not always permitted; the badge cues the user to click the icon */
  }
}

// --- popup requests --------------------------------------------------------

ext.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
  // The catch is not optional: without it an unexpected rejection (a Firestore
  // read failing inside JOIN_ROOM, say) leaves the channel unanswered, the
  // popup's `await sendBg(...)` rejects un-caught, and its `setBusy(false)`
  // never runs — every button stays disabled with no error shown.
  handlePopupMessage(msg)
    .then(sendResponse)
    .catch((e) => {
      fail('bg', 'popup request failed', msg.t, e);
      sendResponse({ ok: false, error: (e as Error)?.message ?? 'Something went wrong.' });
    });
  return true; // async response
});

async function handlePopupMessage(msg: PopupRequest): Promise<PopupResponse> {
  switch (msg.t) {
    case 'START_PICKER': {
      const tab = await activeTab();
      if (tab?.id == null) return { ok: false, error: 'No active tab.' };
      const frames = framesInTab(tab.id);
      if (frames.length === 0) {
        return {
          ok: false,
          error: 'Cannot access this page. Refresh the tab, then try again.',
        };
      }
      // Ask every frame; only those holding a video will arm an overlay.
      lastError = null;
      pickMode = 'create';
      pickArmed = 0;
      clearPickTimer();
      frames.forEach((f) => f.port.postMessage({ t: 'PICK' } as BgToContent));
      log('bg', `PICK → ${frames.length} frame(s) in tab ${tab.id}`);
      // If nothing armed shortly after, there's genuinely no reachable video.
      pickTimer = setTimeout(() => {
        if (pickArmed === 0) {
          lastError =
            'No playable video found on this page. The player may be blocked or not loaded yet.';
          void ext.action.setBadgeText({ text: '!' }).catch(() => undefined);
          warn('bg', 'no frame armed a picker — no reachable <video>');
        }
      }, 1200);
      return { ok: true };
    }

    case 'CANCEL_PICKER': {
      const tab = await activeTab();
      clearPickTimer();
      if (tab?.id != null) {
        framesInTab(tab.id).forEach((f) => f.port.postMessage({ t: 'PICK_CANCEL' } as BgToContent));
      }
      return { ok: true };
    }

    case 'GET_PENDING_PICK': {
      const { [PENDING_PICK_KEY]: pick } = await ext.storage.local.get(PENDING_PICK_KEY);
      return { ok: true, pendingPick: (pick as PendingPick) ?? null };
    }

    case 'CLEAR_PENDING_PICK':
      await ext.storage.local.remove(PENDING_PICK_KEY);
      await ext.action.setBadgeText({ text: '' }).catch(() => undefined);
      return { ok: true };

    case 'CREATE_ROOM_ATTACH': {
      const me = await getMe();
      if (!me) return { ok: false, error: 'Not signed in.' };
      const { 'watchparty:pickTab': pickTab } = await ext.storage.local.get('watchparty:pickTab');
      const tab = pickTab ?? (await activeTab())?.id;
      if (tab == null) return { ok: false, error: 'Lost the tab the video was on.' };
      await ext.storage.local.remove([PENDING_PICK_KEY, 'watchparty:pickTab']);
      await ext.action.setBadgeText({ text: '' }).catch(() => undefined);
      // Freshly created here: this player is the truth, so publish its real
      // state rather than adopting the placeholder written at creation.
      return startSession(msg.roomId, 'owner', tab, me, {
        ownerMode: 'publish',
        passphrase: msg.passphrase,
      });
    }

    case 'JOIN_ROOM': {
      const me = await getMe();
      if (!me) return { ok: false, error: 'Not signed in.' };
      const room = await getRoom(msg.roomId);
      if (!room || !room.isActive) return { ok: false, error: 'This room is no longer active.' };
      // Joining from the dashboard: the active tab is the dashboard itself, so
      // give the room a tab of its own instead of navigating away from it.
      let tab: chrome.tabs.Tab | undefined;
      if (msg.newTab) {
        tab = await ext.tabs.create({ url: room.pageUrl, active: true }).catch(() => undefined);
      } else {
        tab = await activeTab();
      }
      if (tab?.id == null) return { ok: false, error: 'No tab available to open the video in.' };
      const tabId = tab.id;
      // Set up the session first so the ATTACH fires as soon as the freshly
      // navigated page's content script says HELLO.
      const res = await startSession(msg.roomId, 'viewer', tabId, me, {
        passphrase: msg.passphrase,
      });
      if (!res.ok) return res;
      if (msg.newTab) {
        // The new tab is already loading the right URL; ATTACH fires on HELLO.
        pendingNav.add(tabId);
        setTimeout(() => pendingNav.delete(tabId), 20000);
      } else if (tab.url !== room.pageUrl) {
        // Mark the tab as intentionally navigating so the old page's port
        // disconnect isn't mistaken for leaving the room. Cleared when the new
        // page attaches (HELLO); the timeout is a safety net if it never loads.
        pendingNav.add(tabId);
        setTimeout(() => pendingNav.delete(tabId), 20000);
        await ext.tabs.update(tabId, { url: room.pageUrl }).catch(() => undefined);
      } else {
        attachTab(tabId); // already on the page
      }
      return { ok: true };
    }

    case 'LEAVE_ROOM': {
      const tabId = session?.tabId;
      if (tabId != null) {
        broadcastToTab(tabId, { t: 'DETACH' });
        broadcastToTopFrame(tabId, { t: 'WIDGET_OFF' });
      }
      await teardownSession({ leave: true });
      return { ok: true };
    }

    case 'GET_ATTACH_STATE': {
      const state: AttachState = {
        roomId: session?.roomId ?? null,
        role: session?.role ?? null,
        error: lastError,
      };
      return { ok: true, attachState: state };
    }
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Rehydrate after a service-worker restart.
void rehydrate();
