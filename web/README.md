# Web dashboard

A companion to the extension: follow what your rooms are doing and keep chatting,
from an ordinary browser tab. It reads the same Firestore project the extension
writes to, so it needs no server of its own.

```bash
npm run web:dev      # http://localhost:5174
npm run web:build    # → web/dist
```

## What it does

- **Live rooms** — what is playing, where it is up to, who is watching right now.
- **History** — every room you have attended, with favourites starred.
- **Chat** — the full transcript, live, and you can send. Messages are encrypted
  and decrypted here with the extension's own `src/shared/crypto.ts`.

Private rooms ask for their passphrase before chat will open. The key is derived
from it and never stored, so there is no way around that — which is the point.
A passphrase you enter is held in `sessionStorage` for the tab only, so switching
between rooms doesn't re-prompt.

## What it deliberately does not do

**It never writes a member document.** Membership means "a browser with the
extension attached to this video"; it drives the watcher count and the automatic
ownership handoff. A dashboard tab is neither, and joining would inflate the
count and make itself a candidate to inherit a room it cannot actually drive.

So it cannot control playback either. Play, pause, seek and host handover stay in
the extension, where the video is.

## Deploying to Vercel

1. **Import the repo** at [vercel.com/new](https://vercel.com/new). Leave the root
   directory as the repository root — `vercel.json` already points the build at
   `npm run web:build` and serves `web/dist`.
2. **Add the environment variables.** Project → Settings → Environment Variables,
   the same six as `.env.example`:

   ```
   VITE_FB_API_KEY
   VITE_FB_AUTH_DOMAIN
   VITE_FB_PROJECT_ID
   VITE_FB_STORAGE_BUCKET
   VITE_FB_SENDER_ID
   VITE_FB_APP_ID
   ```

   `.env` is gitignored, so without these the build compiles the `YOUR_API_KEY`
   placeholders and the deployed site cannot reach Firebase at all.
3. **Authorise the domain.** Firebase console → Authentication → Settings →
   Authorized domains → add your `*.vercel.app` host. Sign-in fails with
   `auth/unauthorized-domain` until you do.
4. Deploy.

## Before you point anyone at it

Publishing this puts a working, unauthenticated-until-login client to your
Firebase project on the open web. Two settings have to be right, and they are the
same two the extension depends on:

- **Public sign-up disabled** (Authentication → Settings). The rules let any
  *signed-in* user read every room, so self-registration would hand strangers the
  whole room list.
- **`firestore.rules` deployed.** Default-open rules plus a public URL is the
  genuinely bad combination.

There is no App Check, so nothing rate-limits requests to the project. That is
the same exposure the extension already has — a public URL just makes it easier
to find. See the "Known gaps" section of `HANDOVER.md`.

The site sends `X-Robots-Tag: noindex` and a matching meta tag, so it should stay
out of search results, but treat that as tidiness rather than access control.
