# WatchParty Sync — browser extension

Turn any webpage's HTML5 `<video>` into a synchronized watch party. A room owner
picks a video with a LocatorJS-style click-to-select overlay; the page URL, a
robust CSS selector, and playback state are stored in **Firebase Firestore**;
other logged-in users join and their player mirrors the owner's play / pause /
seek in realtime. Ownership hands off automatically when the owner leaves.

## Project documents

- **[DECISIONS.md](DECISIONS.md)** — why the architecture is shaped this way, one entry per major decision with the constraint that forced it and what it costs.
- **[HANDOVER.md](HANDOVER.md)** — start here if you are picking this up: current state, where things live, traps that have already bitten, and known gaps.
- **WatchParty-Test-Plan.xlsx** — 113 manual test cases plus 11 regression checks.

## How it maps to the acceptance criteria

| # | Requirement | Where |
|---|---|---|
| 1 | Admin/user access control; admin creates users, users log in on the widget | `firebase/users.ts` (secondary-app create), `firebase/auth.ts`, `popup/views/{Login,AdminUsers}.tsx`, `firestore.rules` |
| 2 | Logged-in user creates a room via a click-to-select video overlay | `content/picker.ts` (overlay + `@medv/finder` selector) |
| 3 | On confirmation, Firestore stores URL + selector + currentTime; user names the room | `popup/views/CreateRoom.tsx`, `firebase/rooms.ts` |
| 4 | A second user sees active rooms and opens one | `popup/views/RoomList.tsx`, background auto-navigates the tab |
| 5 | Owner controls playback; play/pause/seek mirror in realtime | `content/videoController.ts`, `firebase/rooms.ts` (`writePlayback` / `watchRoom`) |
| 6 | On refresh/exit, ownership hands to the next joiner; empty → inactive | `firebase/presence.ts` (`reconcileOwnership`), background port-disconnect handling |
| 7 | Error handling for players that can't be manipulated | `content/videoController.ts` (layered autoplay workaround, DRM/seek errors), `content/picker.ts` (no-video / cross-origin) |

## Browser compatibility

| | Chrome | Edge | Firefox |
|---|---|---|---|
| Manifest | MV3 | MV3 | MV3 |
| Background | service worker | service worker | event page (`background.scripts`) |
| Build | `npm run build` → `dist/` | same `dist/` | `npm run build:firefox` → `dist-firefox/` |
| Host permissions | granted at install | granted at install | **user must opt in** |

The one API difference that matters is the namespace: Firefox's promise-based
API is `browser`, and its `chrome` alias is callback-style — so `await
chrome.tabs.query(...)` there resolves to `undefined` instead of throwing, which
would fail silently. `src/shared/ext.ts` resolves this once
(`globalThis.browser ?? globalThis.chrome`) and every runtime call goes through
it, so no polyfill dependency is needed. Type-only references still use the
`chrome` namespace from `@types/chrome`, which is erased at compile time.

## Architecture (why it's split this way)

The content script runs in the **page's** origin, so it cannot see the popup's
Firebase auth session. All Firebase work therefore lives at the **extension**
origin, shared between the popup and the background service worker via
`indexedDBLocalPersistence`:

- **Popup** (`src/popup`) — interactive UI. Login, admin user-creation, room
  list, create/confirm, in-room controls.
- **Background service worker** (`src/background/service-worker.ts`) — owns all
  *realtime* work (Firestore `onSnapshot`, playback writes, presence heartbeat)
  so it survives the popup closing. Talks to the content script over a
  long-lived port; the 3 s heartbeat over that port also keeps the MV3 worker
  alive while a room is active.
- **Content script** (`src/content`) — pure DOM: the picker overlay and the
  video controller. No Firebase.

## Setup

### 1. Create a Firebase project
- Firebase console → add project (the free **Spark** plan is enough).
- **Authentication → Sign-in method →** enable **Email/Password**.
- **Authentication → Settings →** turn **off** public/self sign-up so accounts
  can only be created through the admin flow.
- **Firestore Database →** create a database (production mode).

### 2. Add your config
Copy `.env.example` to `.env` and fill in the web-app config
(Project settings → Your apps → Web app → SDK setup & config). These values are
not secrets — access is enforced by `firestore.rules`.

### 3. Deploy the security rules
Paste the contents of `firestore.rules` into **Firestore → Rules** and publish.

> There is no `firebase.json`/`.firebaserc` in this repo, so `firebase deploy
> --only firestore:rules` will NOT work until you run `firebase init firestore`.
> The console route is the supported path today.

**Deploy the rules before testing anything.** Chat, history and favourites all
fail with permission errors without them.

### 4. Bootstrap the first admin (one-time, manual)
Because only an admin can create users, seed the first one by hand:
1. **Authentication → Users → Add user** — create an account (email + password);
   copy its **User UID**.
2. **Firestore → Start collection `users` → Document ID = that UID**, fields:
   - `email` (string) — the same email
   - `displayName` (string) — e.g. `Admin`
   - `role` (string) — `admin`

That admin can now create everyone else from the extension's **Users** tab.

### 5. Build & load

**Chrome / Edge**
```bash
npm install
npm run build
```
Then in Chrome: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → select the `dist/` folder. Edge is the same at
`edge://extensions`.

**Firefox**

```bash
npm run build:firefox
```

Then: `about:debugging` → **This Firefox** → **Load Temporary Add-on…** →
select `dist-firefox/manifest.json`.

Three things differ on Firefox, and the first one will bite you:

- **Host permissions are opt-in.** Under Firefox MV3, `<all_urls>` is *requested*
  but not granted at install. Until you approve it (Add-ons Manager → the
  extension → **Permissions** → allow access to all sites), the content script
  never runs and the picker reports that it cannot reach the page.
- **The background is an event page**, not a service worker — Firefox MV3 has no
  `background.service_worker`. `npm run build:firefox` rewrites that key and
  adds the required `browser_specific_settings.gecko` id; the bundled code is
  otherwise identical.
- **Temporary add-ons vanish on restart.** For a permanent install the package
  has to be signed through addons.mozilla.org.

> Newly-opened pages get the content script automatically. Tabs that were
> already open **before** you loaded/reloaded the extension need a page refresh
> before "Create a room" can reach them.

For iterative development use `npm run watch` (rebuilds `dist/` on save; click the
extension's reload icon to pick up changes).

> Avoid `npm run dev`. The CRXJS dev server serves the popup through a redirect
> stub, and because a popup is destroyed every time it loses focus the HMR
> client reconnects endlessly and flashes "Cannot connect to localhost:5173".

## End-to-end test

1. Log in as the admin → **Users** tab → create `user1` and `user2`.
2. In one Chrome profile, sign in as **user1**. Open a page with a plain HTML5
   video (e.g. any `.mp4` or an `<video>` test page). Click **Create a room**,
   click the video in the overlay, name the room, **Create & host**. Confirm a
   doc appears under `rooms` in Firestore.
3. In a second profile (or another machine), sign in as **user2**. The room
   shows under **Active rooms** → **Join** → the tab navigates to the URL and a
   "Click to start watching together" button appears; click it.
4. As user1, play / pause / seek → user2's player follows within ~1 s. Watch the
   `rooms/{id}.playback` field update in Firestore.
5. As user1, refresh or close the tab → ownership moves to user2 (their badge
   flips to **owner** and their controls now drive playback). Close everyone →
   the room flips `isActive: false` and drops off the list.
6. **Error paths:** try a DRM/iframe player (YouTube, Netflix) → you get a clear
   "can't be controlled" message instead of a silent failure; try clicking a
   non-video element in the picker → it's ignored.

## Ownership model

Two separate fields, because "who is host" has two meanings:

| Field | Meaning |
|---|---|
| `ownerUid` | Who drives playback **right now**. Moves automatically when the host leaves. |
| `primaryOwnerUid` | Who holds the **persistent claim**. Set to the creator; only a deliberate transfer moves it. |

That split gives the behaviour you'd expect:

- **Automatic handoff** (leave, refresh, crash) moves `ownerUid` only. If the
  original host returns, `startSession` sees they're still the primary and hands
  the room straight back. `reconcileOwnership` also prefers a present primary
  over join order when promoting.
- **Manual handoff** — the host clicks **Make host** next to a viewer in the
  popup. This moves *both* fields, so the claim genuinely changes hands and the
  previous host will not take it back on their next visit.

Members who hold the claim but aren't currently hosting are labelled
*original host* in the member list.

## Dashboard, history and favourites

The popup's **History** section lists the 10 most recent ended rooms; **View
all** opens a full-page dashboard in a new tab (declared as `options_ui` with
`open_in_tab`, so it's also reachable from the extension's Options entry).

The dashboard has three tabs — **Active**, **★ Favourites**, and **History**
(paginated, 20 per page) — and shows two dates per room: when the room was
created, and when *you* last watched it.

History is per user, at `users/{uid}/history/{roomId}`, written whenever you
join a room. It lives under the user rather than the room because "when did I
last watch this" and "is this one of my favourites" are personal, and because
member documents are pruned when someone leaves. Starring a room keeps it in
Favourites so you can come back to a show you're following.

> Firestore rules do **not** cascade into subcollections, so `history` has its
> own rule: the profile stays admin-only while each user manages their own
> history. Redeploy `firestore.rules` or history writes will be denied.

## Encrypted room chat

Each room has a live chat in the floating widget. Messages are **AES-GCM
encrypted client-side before they reach Firestore**, so `rooms/{id}/messages`
documents hold only `{ iv, ct, senderUid, senderName, createdAt }` — the body is
ciphertext. Browsing the Firebase console or exporting the database shows
nothing readable.

Encryption runs in the **background service worker**, not the page: the content
script never sees the room key, only plaintext for rendering. Messages are
immutable once sent (`allow update: if false`), and only the author or the room
host may delete one.

### Public vs private rooms

Rooms are created as one or the other, and it decides where the key lives:

| | **Public** | **Private** |
|---|---|---|
| Joining | One click, any signed-in user | Passphrase required |
| Key | Random, **stored** on the room doc | **Derived** from the passphrase (PBKDF2, 250k iters) |
| Stored in Firestore | `chatKey` | `chatSalt` + `chatCheck` verifier — never the key |
| Console shows | Ciphertext | Ciphertext |
| Can project owner decrypt? | Yes, by taking the key | **No** |

Both store ciphertext, so chat is never readable by browsing Firestore. The
difference is whether a determined person *with database access* could decrypt:
for a public room they could lift `chatKey` and do it offline; for a private
room the key exists only in the heads of people who know the passphrase.

The passphrase is validated against `chatCheck` — a fixed sentinel encrypted at
creation. A wrong passphrase fails AES-GCM's auth tag, so it's rejected without
the passphrase ever being stored or transmitted anywhere but the client. Once
accepted it's cached in `chrome.storage.session` so a rejoin doesn't re-prompt;
it's gone when the browser closes.

**If a private room's passphrase is lost, its chat history is unrecoverable** —
by you, by admins, by anyone. That's the point, but it is worth knowing.

## Room lifecycle

A room's liveness is **derived**, not just a flag — otherwise a crashed or
closed browser would leave a room "active" forever.

- While attached, the **owner** stamps `rooms/{id}.lastActiveAt` every
  `ROOM_TOUCH_MS` (9 s).
- A room counts as live when `isActive !== false` **and** its heartbeat is
  newer than `ROOM_STALE_MS` (30 s). See `isRoomLive` in `src/firebase/rooms.ts`.
- A clean exit (**Leave**, tab close, refresh) additionally sets
  `isActive: false` the moment the last member goes, so it drops out instantly
  rather than after the 30 s window.

The popup lists live rooms under **Active rooms**; everything else collapses
into **History** with an `ended` badge. Because liveness is computed from a
timestamp, rooms created before this behaviour existed (no `lastActiveAt`) fall
back to `createdAt` and land in History automatically.

## The on-page widget

Once you're in a room, a floating pill appears bottom-right of the **top-level
page**, floating over everything — even when the video itself lives in a nested
player iframe. Click it to expand: room name, your role, host, live viewer
count, play state, and **Leave room**. Player errors raised down in the video
frame are relayed up and shown here too.

It renders in a shadow root, so the host page's CSS can't restyle it and its own
styles can't leak out. The split is deliberate: the **video controller** runs in
whichever frame holds the `<video>`, while the **widget** always runs in the top
frame — the background routes `ROOM_INFO` / `WIDGET_OFF` to the latter and
`ATTACH` / `APPLY` to the former.

## Debugging playback sync

Diagnostic logging is on by default (`DEBUG` in `src/shared/log.ts` — flip it to
`false` to silence everything except real errors). Logs are timestamped
`HH:MM:SS.mmm` so you can line up the owner's action with the viewer's reaction
across two browsers and read the true latency.

Two consoles, two sources:

| Prefix | Where to look |
|---|---|
| `[WP:owner]`, `[WP:viewer]`, `[WP:content]` | the **page's** devtools console (F12 on the video tab) |
| `[WP:bg]` | the **service-worker** console — `chrome://extensions` → the extension → **service worker** |

A healthy pause propagation looks like this:

```
owner page      [WP:owner]  emit pause t=132.44s playing=false
owner SW        [WP:bg]     write playback pause t=132.44 playing=false
viewer SW       [WP:bg]     room snapshot → APPLY t=132.44 playing=false
viewer page     [WP:viewer] apply remote(t=132.44 playing=false) drift=0.31s → pause
```

Reading failures:

- **No `[WP:owner] emit`** → the owner isn't attached, or the role is `viewer`.
- **`emit` but no `[WP:bg] write playback`** → the port or session is broken;
  look for `port closed` / `attachTab skipped`.
- **`writePlayback FAILED`** → Firestore rejected the write (rules, or
  `ownerUid` isn't you). This used to be swallowed silently.
- **`⚠ NO CONTENT PORT`** → the background has no content script for that tab;
  the page likely needs a refresh after loading the extension.
- **`apply ignored`** → arrived while the viewer had no video/role.
- **`play() blocked by autoplay policy`** → expected before the join gate is
  clicked; the muted fallback should follow.

## Known trade-offs (no-backend design)

- "Admin-only user creation" is enforced by the UI plus the `users` collection
  rules; a determined user with the config could still call Firebase Auth
  sign-up directly. Disabling public sign-up (step 4 above) closes the common
  path. A Cloud Function with the Admin SDK would fully lock this down.
- Presence uses a heartbeat. Clean exits (popup **Leave**, tab close/refresh)
  hand off ownership immediately; only a hard crash falls back to the staleness
  window (~`STALE_MS`, 10 s). Freshness is measured server-time vs server-time
  (the newest heartbeat is the reference), so it's immune to client clock skew.
- The reconciler never deactivates a room it's part of and never removes its own
  membership — a sole host can stream alone safely. A room only goes inactive
  when its last member leaves cleanly, so one orphaned by a hard crash (no other
  members) can linger as "active" until someone opens it.
