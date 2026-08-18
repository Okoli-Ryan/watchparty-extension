import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'WatchParty Sync',
  version: '0.1.0',
  description: 'Sync any webpage video across viewers in realtime — a watch party.',
  // Both stores reject a submission without a 128px icon; the smaller sizes are
  // used in the toolbar and the extensions page.
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'WatchParty Sync',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  // The full-page dashboard (history, favourites). Declared as options_ui with
  // open_in_tab so it builds as a proper extension page and opens full-size —
  // "View all" navigates here via tabs.create.
  options_ui: {
    page: 'src/dashboard/index.html',
    open_in_tab: true,
  },
  content_scripts: [
    {
      // `*://*/*` rather than `<all_urls>`: the two are equivalent for http and
      // https, but `<all_urls>` additionally claims file:// and ftp://, which
      // this extension never syncs. Reviewers read the broader pattern as an
      // unjustified ask, and file:// access needs a manual per-user toggle
      // anyway, so the wider form buys nothing.
      matches: ['*://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      // Players are frequently embedded from a third-party host in a
      // cross-origin iframe. Extensions (unlike page JS) may inject into those
      // frames, so we run everywhere and let each frame decide whether it has a
      // video worth picking.
      all_frames: true,
    },
  ],
  // `scripting` was declared but never called — every unused permission is one
  // more thing a reviewer asks about, so it is gone. It would only be needed if
  // this moved to optional host permissions and registered content scripts at
  // runtime (see the note in HANDOVER.md).
  permissions: ['tabs', 'storage', 'activeTab'],
  // Breadth is load-bearing, not laziness: a viewer's tab is NAVIGATED to the
  // room's page by the background, and the content script must already be there
  // to send HELLO — there is no user gesture on that fresh page for activeTab to
  // hang off. Narrowing this to a site list is possible if a deployment only
  // ever uses a few sites; it would end the "any webpage" premise.
  host_permissions: ['*://*/*'],
});
