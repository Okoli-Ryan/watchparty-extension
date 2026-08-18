import { PORT_NAME, type BgToContent, type ContentToBg } from '../shared/messages';
import { HEARTBEAT_MS } from '../shared/constants';
import { log, warn } from '../shared/log';
import { ext } from '../shared/ext';
import { getSettings, watchSettings, getWidgetPos, saveWidgetPos } from '../shared/settings';
import { hasVideo, startPicker, stopPicker } from './picker';
import { VideoController } from './videoController';
import { Widget } from './widget';

// Pure-DOM content script. Talks to the background over a long-lived port; the
// background owns all Firebase/Firestore work.

let port: chrome.runtime.Port | null = null;
let controller: VideoController | null = null;
let widget: Widget | null = null;
let unwatchSettings: (() => void) | undefined;
let heartbeatTimer: number | undefined;

function connect() {
  port = ext.runtime.connect({ name: PORT_NAME });
  const isTop = window.top === window.self;
  log('content', `port connected → HELLO (${isTop ? 'top' : 'iframe'})`, location.origin);
  send({ t: 'HELLO', origin: location.origin, isTop });

  port.onMessage.addListener((msg: BgToContent) => handle(msg));
  port.onDisconnect.addListener(() => {
    warn('content', 'port disconnected (service worker asleep or reloaded) — reconnecting');
    port = null;
    teardown();
    // The service worker may have been recycled; reconnect so we can be
    // re-attached. Cheap because we only rebuild the port, not any UI.
    setTimeout(connect, 500);
  });
}

function send(msg: ContentToBg) {
  try {
    port?.postMessage(msg);
  } catch {
    /* port closed; will reconnect */
  }
}

function handle(msg: BgToContent) {
  switch (msg.t) {
    case 'PICK':
      // Only frames that actually hold a video arm the overlay, so the top
      // document doesn't cover an embedded player and eat its clicks.
      if (!hasVideo()) {
        log('content', 'PICK ignored — no video in this frame', location.origin);
        return;
      }
      send({ t: 'PICK_READY' });
      startPicker({
        onPick: (r) =>
          send({
            t: 'PICK_RESULT',
            selector: r.selector,
            currentTime: r.currentTime,
            frameUrl: r.frameUrl,
            frameOrigin: r.frameOrigin,
            isTop: r.isTop,
          }),
        onError: (reason) => send({ t: 'PICK_ERROR', reason }),
        onCancel: () => send({ t: 'PICK_ERROR', reason: 'cancelled' }),
      });
      break;

    case 'PICK_CANCEL':
      stopPicker();
      break;

    case 'ATTACH':
      // Only tears down the controller — the widget belongs to the top frame
      // and must survive re-attach.
      teardownController();
      controller = new VideoController(msg.selector, msg.role, {
        onEvent: (e) => send({ t: 'VIDEO_EVENT', ...e }),
        onAttached: () => {
          send({ t: 'ATTACHED' });
          startHeartbeat();
        },
        onError: (reason) => send({ t: 'ATTACH_ERROR', reason }),
        onMeta: (duration) => send({ t: 'VIDEO_META', duration }),
      });
      // Tells an attaching owner whether to publish its own position (new room)
      // or adopt the room's existing one (returning host).
      controller.ownerMode = msg.ownerMode;
      controller.initialRemote = msg.playback;
      void controller.attach();
      break;

    case 'ROOM_INFO':
      // Addressed to the top frame; mount lazily on first info.
      if (!widget) {
        widget = new Widget({
          onLeave: () => send({ t: 'LEAVE' }),
          onSend: (text) => send({ t: 'CHAT_SEND', text }),
          onOpenDashboard: () => send({ t: 'OPEN_DASHBOARD' }),
          onResync: () => send({ t: 'RESYNC_REQUEST' }),
          onRetry: () => send({ t: 'RETRY_ATTACH' }),
          onSeek: (seconds) => send({ t: 'SEEK_TO', seconds }),
          onTransferHost: (uid) => send({ t: 'TRANSFER_HOST', uid }),
          onReselectVideo: () => send({ t: 'RESELECT_VIDEO' }),
          onMove: (pos) => void saveWidgetPos(pos),
        });
        widget.mount();
        // Restore where the user last dragged it, and apply the saved beep
        // preference, following changes made from the dashboard's settings.
        void getWidgetPos().then((pos) => widget?.setPosition(pos));
        void getSettings().then((s) => widget?.setBeepEnabled(s.chatBeep));
        unwatchSettings?.();
        unwatchSettings = watchSettings((s) => widget?.setBeepEnabled(s.chatBeep));
      }
      widget.update(msg.info);
      widget.setError(msg.info.error);
      break;

    case 'CHAT':
      widget?.setMessages(msg.messages);
      break;

    case 'WIDGET_OFF':
      widget?.destroy();
      widget = null;
      break;

    case 'SET_ROLE':
      controller?.setRole(msg.role);
      break;

    case 'APPLY':
      controller?.apply(msg.playback);
      break;

    case 'REQUEST_STATE':
      controller?.reportState();
      break;

    case 'RESYNC': {
      const text = controller
        ? controller.resync(msg.playback, msg.elapsedMs)
        : "Can't sync — not attached";
      send({ t: 'RESYNC_DONE', text });
      break;
    }

    case 'RESYNC_STATUS':
      widget?.setResyncStatus(msg.text);
      break;

    case 'RETRY':
      void controller?.retry();
      break;

    case 'SEEK':
      controller?.seekTo(msg.seconds);
      break;

    case 'DETACH':
      teardown();
      break;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  // Heartbeat over the port both drives Firestore presence (background writes
  // the lastSeen) and keeps the MV3 service worker alive while we're attached.
  heartbeatTimer = window.setInterval(() => send({ t: 'HEARTBEAT' }), HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

/** Stop controlling the video, but leave the widget alone. */
function teardownController() {
  stopHeartbeat();
  controller?.detach();
  controller = null;
}

function teardown() {
  teardownController();
  unwatchSettings?.();
  unwatchSettings = undefined;
  widget?.destroy();
  widget = null;
  stopPicker();
}

// On unload the port disconnects; the background treats that as us leaving and
// hands off ownership. Nothing extra to send here.
connect();
