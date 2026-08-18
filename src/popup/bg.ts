import type { PopupRequest, PopupResponse } from '../shared/messages';
import { ext } from '../shared/ext';

/** Typed one-shot request to the background service worker. */
export function sendBg(msg: PopupRequest): Promise<PopupResponse> {
  return ext.runtime.sendMessage(msg) as Promise<PopupResponse>;
}
