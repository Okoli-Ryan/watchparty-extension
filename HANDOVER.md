# Handover

For whoever picks this up next. Read `DECISIONS.md` alongside this — it explains
*why* the odd-looking parts are that way, and most of them were paid for with a
bug.

---

## What this is

A Chrome/Edge/Firefox MV3 extension for synchronised video watching. A host
picks a `<video>` on any page; viewers join and their player mirrors the host's
play, pause and seek in realtime through Firebase Firestore. It also has
encrypted room chat, reactions, per-user history and favourites, and a full-page
dashboard.

All seven original acceptance criteria are implemented (access control, keyboard-driven
room creation, room discovery, realtime playback control, ownership handoff on
exit, and error handling for uncontrollable players).

---

## Current state

**Working and building cleanly.** `npm run build` and `npm run build:firefox`
both pass with TypeScript strict mode and no errors.

**Never verified at runtime.** This is the single most important thing to know.
Every feature was written and type-checked, and the user tested some of it and
reported bugs which were fixed — but no automated tests exist, and the assistant
could not run the extension (it needs a real browser plus the user's Firebase
project). Treat the app as *unverified* outside the flows the user explicitly
confirmed.

`WatchParty-Test-Plan.xlsx` in this folder has 113 manual test cases and 11
regression checks. Nothing in it has been run.

### Fixed in the pre-publication code review (unverified at runtime)

A static review before the first git commit found eight defects. All were fixed;
none has been exercised in a browser, so re-test these paths first.

| Area | What was wrong |
|---|---|
| Widget panel | The "Watching" count and the host's roster both used `data-f="members"`, so `patch()` overwrote the count with the roster markup and the real roster never updated. The roster is now `data-f="roster"`. |
| Join / room lifecycle | `startSession()` always left the old room first, so pressing "Join" on the room you were already alone in ran `deactivateIfEmpty()` and killed it. Re-entry now skips the leave path. |
| Popup ↔ background | An unexpected rejection in a popup handler left the message channel unanswered, freezing the popup's buttons. `sendResponse` now has a `.catch`. |
| Playback sync | The 150 ms throttle *dropped* the final `seeked` of a scrub. It is now deferred and flushed instead. |
| Picker | Frames that armed an overlay but weren't the one picked kept a full-viewport click-swallowing overlay. `onPickResult` now cancels every frame. |
| Presence | `joinRoom()` wrote the requested role, not `effectiveRole`, so a reclaiming primary owner was stored as `viewer`. |
| Chat | The async `onSnapshot` handler could deliver decrypted batches out of order; results are now sequenced. |
| Cross-browser | `isFirefox` could never be true, because Firefox defines `chrome` as well as `browser`. |

---

## Get it running

1. `cp .env.example .env` and fill in the Firebase web config.
2. Publish `firestore.rules` in the Firebase console. **Do this first** — chat,
   history and favourites all fail with permission errors without it, and the
   failures used to be silent.
3. Seed the first admin by hand: create an Auth user, then a `users/{uid}` doc
   with `role: "admin"` (README step 4). There is no bootstrap path in the app —
   by design, since only admins can create users.
4. `npm run build`, then load `dist/` unpacked. Firefox: `npm run build:firefox`
   and load `dist-firefox/manifest.json` via `about:debugging`, **and grant host
   permissions manually** — Firefox MV3 makes them opt-in, and without them the
   content script never runs.

Two browser profiles are needed for any multi-user testing.

---

## Where things live

```
src/shared/messages.ts   ← read this first: the contract between contexts
src/background/          ← service worker: all Firestore + realtime + routing
src/content/             ← pure DOM: picker, video controller, floating widget
src/popup/               ← discovery UI (login, room list, create, status)
src/dashboard/           ← full page: history, favourites, settings
src/firebase/            ← data layer, one module per collection
firestore.rules          ← the entire security model
scripts/build-firefox.mjs← rewrites the built manifest for Gecko
```

The service worker is the hub. If behaviour is wrong, its console
(`chrome://extensions` → the extension → "service worker") is almost always
where the answer is.

---

## Debugging

Set `DEBUG = true` in `src/shared/log.ts` (it ships `false`). Logs are split:

- `[WP:bg]` → service-worker console
- `[WP:owner]` / `[WP:viewer]` / `[WP:content]` → the **page's** console

Everything is timestamped to the millisecond so you can line up a host action
with the viewer's reaction across two browsers. A healthy pause looks like:

```
owner page   [WP:owner]  emit pause t=132.44s playing=false
owner SW     [WP:bg]     write playback pause t=132.44 playing=false
viewer SW    [WP:bg]     room snapshot → APPLY t=132.44 playing=false
viewer page  [WP:viewer] apply remote(...) drift=0.31s → pause
```

Whichever line is missing tells you which hop broke. The README has a table
mapping each failure to its cause.

---

## Traps that have already bitten, in order of how much time they cost

1. **Conditional rendering in the widget's `build()`.** `patch()` silently
   no-ops on missing elements, so anything built conditionally never appears.
   Caused three separate bugs. Always emit the element hidden, or put the
   changing thing in the render signature.
2. **Firestore's first snapshot is from cache.** For a joining user it contains
   only their own pending write, so the reconciler concluded the host was gone
   and promoted the joiner. Ownership decisions must check `fromCache`.
3. **Server timestamps vs `Date.now()`.** Mixing them killed rooms after ten
   seconds. Use `serverNow()` from `presence.ts`.
4. **Port disconnects during intentional navigation.** Joining navigates the
   tab, which closes the old page's port; that used to read as "left the room"
   and tore down the session. `pendingNav` guards it.
5. **Content-script timers throttle in hidden tabs.** Never drive presence or
   anything time-critical from one.
6. **The dev server.** `npm run dev` serves the popup via a redirect stub and
   flashes "Cannot connect to localhost:5173" endlessly, because a popup is
   destroyed on every focus loss. Use `npm run watch` (build --watch) instead.

---

## Known gaps

- **Sign-out doesn't leave the room.** `logout()` only calls Firebase `signOut`;
  the background session keeps heartbeating, so the user stays "in" a room they
  are signed out of and their writes then fail auth. Small fix: send
  `LEAVE_ROOM` before signing out, and tear down on observing an unauthenticated
  user. This was flagged and never actioned.
- **MV3 worker suspension** can still stall presence if a tab is hidden and idle.
  Fully solving it needs `chrome.alarms` (30s minimum), which would mean
  loosening `STALE_MS` and slowing handoff — a real trade-off, not an oversight.
- **Broad host permissions** are still the biggest obstacle to store approval.
  `<all_urls>` has been narrowed to `*://*/*` (equivalent for http/https, drops
  the file:// and ftp:// claim) and the unused `scripting` permission removed,
  but the breadth itself is load-bearing: the background NAVIGATES a viewer's tab
  to the room's page and then waits for that page's content script to send
  `HELLO`. There is no user gesture there, so `activeTab` cannot substitute.

  Two ways out, neither taken yet:
  1. **Narrow to a site list** in `manifest.config.ts`. Best review outcome, ends
     the "any webpage" premise. Right answer if a deployment only uses a few
     sites.
  2. **Optional host permissions** — ship with none, call
     `chrome.permissions.request()` when the user creates or joins a room, then
     `chrome.scripting.registerContentScripts()` for the granted origin (this is
     what would re-earn the `scripting` permission). Correct long-term, but
     `permissions.request()` needs a user gesture on an extension page and Chrome
     often closes the **popup** when the permission dialog takes focus — so the
     grant flow has to move to the dashboard or an onboarding page first.

  Until then: publish **Unlisted (Chrome) / Hidden (Edge)**. For an
  admin-provisioned tool that is the intended distribution anyway, and it draws
  far less review scrutiny than a public listing asking for every host.
- **Icons are generated placeholders** (a purple play triangle), fine to ship
  but not designed.
- **No automated tests.** The pure logic in `presence.ts`, `crypto.ts` and
  `dates.ts` is easily unit-testable and would be the sensible first target.
- **Rooms created before a feature existed** lack its fields — pre-chat rooms
  have no `chatKey` and chat is disabled for them. Readers default sensibly, but
  when testing an old room, suspect this first.

---

## Publishing

Two documents cover this, and **both are gitignored** — they carry submission
copy and a personal contact address, so they stay out of the public repo. Ask
the maintainer for them:

- `STORE_LISTING.md` — finished copy: descriptions, category, data disclosures
  and written permission justifications.
- `PRIVACY.md` — the privacy policy. Written and complete, but it still **must
  be hosted at a public URL** (a Gist or GitHub Pages will do) before either
  store will accept a submission.

Screenshots still need capturing. Unlisted (Chrome) / Hidden (Edge) suits an
admin-provisioned tool and draws far less review scrutiny.

---

## Suggested next steps

1. Run the test plan — it is the highest-value thing available, since nothing has
   been verified end to end.
2. Fix the sign-out gap; it is small and user-visible.
3. Add unit tests for `presence.ts` (freshness, ownership reconciliation) — that
   file has produced more bugs than any other and is pure logic.
4. Decide how to handle the broad host permission before attempting store
   submission — the options are laid out under "Known gaps".
