// Message protocol between the three extension contexts.
//
//  • Popup (extension origin)  — interactive UI. Holds the Firebase session and
//    does user/room CRUD directly. Talks to the background via one-shot
//    chrome.runtime.sendMessage.
//  • Background service worker (extension origin) — owns the *realtime* work
//    (onSnapshot, playback writes, presence heartbeat) so it survives the popup
//    closing. Shares the Firebase auth session with the popup (same origin).
//  • Content script (PAGE origin) — pure DOM: picker overlay + video control.
//    Cannot see the extension's Firebase session, so it only exchanges DOM-level
//    messages with the background over a long-lived Port.

import type { PlaybackState, MemberRole, ChatMessage } from './types';

// ---- Popup → Background (one-shot request/response) ------------------------

export type PopupRequest =
  | { t: 'START_PICKER' }
  | { t: 'CANCEL_PICKER' }
  | { t: 'GET_PENDING_PICK' }
  | { t: 'CLEAR_PENDING_PICK' }
  // `passphrase` is only sent for private rooms; it is never persisted beyond
  // chrome.storage.session and never written to Firestore.
  | { t: 'CREATE_ROOM_ATTACH'; roomId: string; passphrase?: string }
  // `newTab` is set when joining from the dashboard: the active tab there IS
  // the dashboard, so the room must open in a tab of its own.
  | { t: 'JOIN_ROOM'; roomId: string; passphrase?: string; newTab?: boolean }
  | { t: 'LEAVE_ROOM' }
  | { t: 'GET_ATTACH_STATE' };

export interface PendingPick {
  selector: string;
  currentTime: number;
  /** The TOP-level page URL (what a joining viewer navigates to). */
  pageUrl: string;
  pageTitle: string;
  /**
   * Origin of the frame the video lives in ('' when it's the top document).
   * Embed URLs usually carry per-session tokens, so viewers match on origin
   * rather than the full frame URL.
   */
  frameOrigin: string;
}

/** What the background is currently doing, surfaced to the popup RoomView. */
export interface AttachState {
  roomId: string | null;
  role: MemberRole | null;
  error: string | null;
}

export type PopupResponse =
  | { ok: true }
  | { ok: true; pendingPick: PendingPick | null }
  | { ok: true; attachState: AttachState }
  | { ok: false; error: string };

// ---- Content ⇄ Background (long-lived Port, name = 'room') -----------------

/** Background → Content over the port. */
export type BgToContent =
  | { t: 'PICK' } // enter picker mode
  | { t: 'PICK_CANCEL' }
  | {
      t: 'ATTACH';
      roomId: string;
      selector: string;
      role: MemberRole;
      /**
       * How an attaching OWNER reconciles with the room's stored playback:
       *  • 'publish' — the room was just created here, so this player is the
       *    truth and its real state is written out.
       *  • 'adopt'   — we're (re)joining a room that already has a position
       *    (e.g. the original host returning). Move to the room's position
       *    instead of resetting everyone to this fresh page's 0:00.
       */
      ownerMode: 'publish' | 'adopt';
      playback: PlaybackState | null;
    }
  | { t: 'SET_ROLE'; role: MemberRole } // ownership handoff
  | { t: 'APPLY'; playback: PlaybackState } // viewer: mirror owner state
  | { t: 'REQUEST_STATE' } // owner: publish current seek/play state now
  // Viewer re-align. Carries the authoritative state plus how long ago the host
  // wrote it (measured on the background's calibrated server clock), so the
  // content script never has to guess how stale its own copy is.
  | { t: 'RESYNC'; playback: PlaybackState; elapsedMs: number }
  | { t: 'RESYNC_STATUS'; text: string } // outcome, shown on the widget button
  | { t: 'RETRY' } // re-run the video lookup on the page
  | { t: 'SEEK'; seconds: number } // jump to an absolute position
  // ROOM_INFO / WIDGET_OFF are addressed to the TOP frame, which owns the
  // floating widget. The video may live in a nested player iframe, but the
  // widget should float over the whole page.
  | { t: 'ROOM_INFO'; info: RoomInfo }
  | { t: 'CHAT'; messages: ChatMessage[] } // decrypted in the background
  | { t: 'WIDGET_OFF' }
  | { t: 'DETACH' };

/** Snapshot of room state rendered by the in-page widget. */
export interface RoomInfo {
  name: string;
  ownerName: string;
  /** My uid, so the widget can style my own chat messages differently. */
  myUid: string;
  role: MemberRole;
  members: number;
  isPlaying: boolean;
  /** Media length in seconds, 0 when unknown — bounds chat timestamp links. */
  duration: number;
  /** Present members, so the host can hand the room to a specific person. */
  memberList: { uid: string; name: string; isHost: boolean }[];
  /** Player error raised in the video frame, surfaced on the top-frame widget. */
  error: string | null;
}

/** Content → Background over the port. */
export type ContentToBg =
  // Every frame announces itself; the background keys ports by tab+frame and
  // uses `origin` to route ATTACH to the frame that holds the video.
  | { t: 'HELLO'; origin: string; isTop: boolean }
  | { t: 'HEARTBEAT' } // keeps the SW alive while attached
  | { t: 'PICK_READY' } // this frame has a video and armed its overlay
  | {
      t: 'PICK_RESULT';
      selector: string;
      currentTime: number;
      frameUrl: string;
      frameOrigin: string;
      isTop: boolean;
    }
  | { t: 'PICK_ERROR'; reason: string }
  | {
      t: 'VIDEO_EVENT';
      // 'sync' is an on-demand full-state publish (e.g. when a viewer joins),
      // not a DOM event.
      event: 'play' | 'pause' | 'seeked' | 'ratechange' | 'sync';
      currentTime: number;
      isPlaying: boolean;
      rate: number;
    }
  | { t: 'ATTACH_ERROR'; reason: string }
  | { t: 'LEAVE' } // user hit "Leave" in the on-page widget
  | { t: 'CHAT_SEND'; text: string } // plaintext; encrypted in the background
  | { t: 'OPEN_DASHBOARD' } // widget button → background opens the tab
  | { t: 'RESYNC_REQUEST' } // viewer asked to re-align with the host
  | { t: 'RESYNC_DONE'; text: string } // what the re-align actually did
  | { t: 'RETRY_ATTACH' } // widget Retry after "couldn't find the video"
  | { t: 'VIDEO_META'; duration: number } // media length, 0 when unknown
  | { t: 'SEEK_TO'; seconds: number } // clicked a timestamp in chat
  | { t: 'TRANSFER_HOST'; uid: string } // host handed the room to this member
  | { t: 'RESELECT_VIDEO' } // host wants to point the room at a different video
  | { t: 'ATTACHED' }; // video found & controllable

export const PORT_NAME = 'watchparty-room';
export const PENDING_PICK_KEY = 'watchparty:pendingPick';
