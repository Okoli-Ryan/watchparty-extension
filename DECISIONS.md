# Design decisions

Why this extension is built the way it is. Each entry records the decision, the
constraint that forced it, and what it costs — the reasoning matters more than
the rule, because most of these were discovered by hitting the failure.

---

## 1. Three execution contexts, split by what each one can see

**Decision.** The popup and the background service worker share the Firebase
session; the content script does pure DOM work and holds no Firebase code.

**Why.** A content script runs in the *page's* origin, so it cannot reach the
extension-origin auth session. Trying to give it Firestore access would have
meant shipping credentials into every page the user visits.

**Consequence.** Everything crossing that boundary is an explicit message in
`src/shared/messages.ts`. That file is the contract; read it first.

---

## 2. Auth persistence is `indexedDBLocalPersistence`

**Decision.** Not `browserLocalPersistence`.

**Why.** A service worker has no `localStorage`. IndexedDB works in both the
popup and the worker, and because both run at the same `chrome-extension://`
origin they share one persisted session — which is what lets the popup sign in
and the worker use that session for realtime work.

---

## 3. The background owns all realtime work

**Decision.** Firestore subscriptions, playback writes, presence and chat
decryption live in the service worker, not the popup.

**Why.** The popup is destroyed whenever it loses focus. Anything owned by it
would die mid-session.

**Consequence.** MV3 can still suspend the worker. A long-lived port from the
content script keeps it alive while a room is attached, and `rehydrate()`
rebuilds the session from `storage.session` after a restart.

---

## 4. No backend — Firestore rules are the whole security model

**Decision.** Client-only, Firebase Spark plan.

**Cost, stated plainly.** Admin-only user creation is enforced by the UI plus
the `users` rules, not at the auth layer. Disabling public sign-up in the
Firebase console closes the common path; a Cloud Function with the Admin SDK
would close it properly. The rules also let any signed-in user set `ownerUid`
to themselves, which is required for a stranded viewer to self-promote.

---

## 5. Admin user creation runs on a secondary Firebase app

**Decision.** `withSecondaryApp()` in `src/firebase/config.ts`.

**Why.** `createUserWithEmailAndPassword` signs the new user into whatever auth
instance runs it. On the primary app it would silently sign the admin out and
in as the user they just created. A disposable in-memory app avoids that; the
profile doc is then written by the admin's session, which is what the rules
authorise.

---

## 6. Presence uses a calibrated clock, never `Date.now()` vs a server timestamp

**Decision.** `src/firebase/presence.ts` estimates the skew between server and
local time from the freshest heartbeat, then ages members against
`Date.now() + offset`.

**Why.** This caused the project's first serious bug: comparing a
`serverTimestamp` against the local clock made a host with a fast clock judge
*itself* stale within ten seconds, prune its own membership and kill the room.
Measuring freshness relative to the newest heartbeat alone was also wrong — if
every member froze at once they all stayed "fresh" forever. The calibrated
clock is immune to skew *and* still ages in real time.

**Rule for future work.** Never compare a Firestore server timestamp to
`Date.now()`. Use `serverNow()`.

---

## 7. Presence writes come from the background, not the content script

**Decision.** A background `setInterval` writes heartbeats; the content
script's message only keeps the worker alive.

**Why.** Chrome throttles timers in hidden tabs to roughly once a minute after
five minutes. A viewer who switched tabs would go stale, vanish from the
watcher count, and could trigger a spurious ownership handoff.

---

## 8. Ownership is two fields, not one

| Field | Meaning |
|---|---|
| `ownerUid` | Who drives playback now; moves automatically when the host leaves |
| `primaryOwnerUid` | The persistent claim; only a deliberate transfer moves it |

**Why.** "The original host gets their room back" and "handing over is
permanent" are contradictory with a single field. Splitting them makes both
behaviours fall out naturally.

---

## 9. Room liveness is derived, not a flag

**Decision.** A room is live when `isActive !== false` **and** its
`lastActiveAt` heartbeat is under `ROOM_STALE_MS` old.

**Why.** Relying on someone to write `isActive: false` meant a crashed browser
left rooms active forever. A derived rule expires them with no cooperation from
any client.

---

## 10. Sync is event-driven

**Decision.** Viewers realign only on real host actions (play/pause/seek/rate,
and the on-demand publish when someone joins). No periodic correction.

**Why.** This was an explicit product call: perfect sync isn't worth constant
micro-seeking, which fights the viewer's own buffering. `DRIFT_THRESHOLD` is
2s so ordinary latency doesn't cause a visible jump; **Sync with host** exists
for when a viewer has genuinely drifted.

**Watch out.** Because there is no periodic republish, `playback.currentTime`
can be minutes old. Anything computing "where is the host now" must project
forward from a trustworthy elapsed time — see `RESYNC` in the service worker.

---

## 11. Autoplay is handled in layers, and never with an alert

1. A one-time in-page gate button gives the user gesture that unlocks `play()`.
2. On `NotAllowedError`, retry muted (always permitted) and show an unmute chip.
3. If that also fails, log it — do not show a banner.

**Why no banner.** Rejected `play()` calls are usually transient, and in the
genuinely-blocked case the gate is already on screen offering the fix.

---

## 12. Frames: controller follows the video, widget stays on top

**Decision.** `all_frames: true`; ports keyed by `` `${tabId}:${frameId}` ``;
the `VideoController` attaches in whichever frame holds the `<video>` while the
widget always renders in the top frame.

**Why.** Streaming sites embed players in cross-origin iframes. Extensions
*can* inject there (unlike page JS), but the top document's overlay would
otherwise swallow the picker's clicks, and a widget inside the player frame is
clipped to it and destroyed on every iframe reload.

**Gotcha.** Keying ports by tab alone silently dropped every frame but the
last. Rooms store `frameOrigin` (not the full embed URL) because embed URLs
carry per-session tokens.

---

## 13. Chat encryption: two modes, honestly labelled

| | Public room | Private room |
|---|---|---|
| Key | Random, stored on the room doc | Derived from a passphrase (PBKDF2, 250k) |
| Stored | `chatKey` | `chatSalt` + a verifier, **never the key** |
| Console shows | Ciphertext | Ciphertext |
| Project owner can decrypt? | Yes, via the key | **No** |

Encryption happens in the background, so the content script never sees the key.
A passphrase is validated by decrypting a known sentinel, so nothing secret
reaches the server. **A lost private passphrase means that room's history is
gone permanently.**

---

## 14. The widget renders with a build/patch split — the project's most repeated bug

**Decision.** `build()` creates structure keyed by a signature; `patch()`
updates volatile fields in place.

**Why.** Rebuilding on every update destroyed the chat input mid-typing.

**The trap, hit three times.** Anything rendered *conditionally* in `build()`
is invisible to `patch()`, which silently no-ops on a missing element. This
caused: the role chip never appearing, the unread badge never appearing, and a
new host still seeing "Sync with host" after a handoff.

**Rule.** Either always emit the element (hidden when empty) and reveal it in
`patch()`, or put the thing that changes into the render signature. Never
render it conditionally and hope `patch()` finds it.

---

## 15. Cross-browser via one shim, not a polyfill

**Decision.** `src/shared/ext.ts` resolves `globalThis.browser ?? globalThis.chrome`.

**Why.** Firefox's promise API is `browser`; its `chrome` alias is
callback-style, so `await chrome.tabs.query(...)` resolves to `undefined` —
a silent failure, not a crash. Type-only references still use the `chrome`
namespace, which is erased at compile time.

Firefox MV3 has no `background.service_worker`, so `scripts/build-firefox.mjs`
copies `dist/` and rewrites the manifest rather than maintaining two builds.

---

## 16. History and favourites are per user

**Decision.** `users/{uid}/history/{roomId}`, written on every session start.

**Why.** "When did *I* last watch this" is personal, and room-side member docs
are pruned on exit — exactly when you'd want the record. Deriving history from
the global rooms collection showed every room ever created to brand-new users.

**Note.** Firestore rules do not cascade into subcollections; `history` has its
own rule.

---

## 17. Controls live on the floating widget

**Decision.** Chat, reactions, timestamps, host handover, Change video and Sync
with host are on the in-page widget. The popup is for discovery (active rooms,
create, join) and status.

**Why.** The widget is where the user actually is while watching, and it
persists; the popup closes on focus loss. Duplicating controls meant two
implementations to keep in sync.
