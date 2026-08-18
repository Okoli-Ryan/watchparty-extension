# Installing without a store

How to get WatchParty Sync onto Chrome, Edge and Brave when it isn't published
to the Chrome Web Store — with automatic updates, and without the "developer
mode" nag that **Load unpacked** triggers on every browser start.

---

## Why it works this way

You cannot simply send someone a `.crx` file. Chrome and Edge reject off-store
`.crx` files dragged onto `chrome://extensions` with
**`CRX_REQUIRED_PROOF_MISSING`** — they demand a Web Store signature that no
local tool can produce. Every "just double-click the .crx" guide you'll find
online predates that change.

Extensions installed through the **`ExtensionInstallForcelist` enterprise
policy** are exempt from that check. That is the supported self-hosted route,
and it happens to be the nicer one: the browser fetches the extension itself,
keeps it updated, and stops nagging about developer mode.

The trade-off, stated plainly: a policy-installed extension **cannot be disabled
or removed by the user** from `chrome://extensions`. It goes away when the policy
does. That is appropriate for a tool an admin provisions; it would be rude for
anything else.

---

## For the maintainer: cutting a release

**1. Bump the version.** In `package.json` only — `manifest.config.ts` reads it
from there. Browsers only pull an update when the manifest version *increases*,
so a release without a bump reaches nobody.

**2. Build and pack.**

```bash
npm run pack
```

This produces, in `release/`:

| File | What it's for |
|---|---|
| `watchparty-sync.crx` | the signed package |
| `updates.xml` | the update manifest browsers poll |
| `install-policy.reg` | registry entries for Chrome, Edge and Brave |
| `uninstall-policy.reg` | removes those entries again |

**3. Create a GitHub release** and attach **both** `watchparty-sync.crx` *and*
`updates.xml` as assets. The policy points at
`releases/latest/download/…`, which always resolves to the newest release, so
the registry entry never has to change again.

```bash
gh release create v0.1.0 release/watchparty-sync.crx release/updates.xml \
  --title "v0.1.0" --notes "First distributable build."
```

**4. Send colleagues `release/install-policy.reg`** and the section below.

### About `key.pem`

The first `npm run pack` generates `key.pem` in the project root. **It is the
extension's identity.** Its hash becomes the extension id, so:

- **Back it up somewhere safe.** Lose it and you cannot update existing
  installs — a new key yields a new id, which browsers treat as an entirely
  different extension. Everyone would have to reinstall.
- **Never share or commit it.** Anyone holding it can publish an update that
  your users' browsers install automatically, with no prompt. It is gitignored;
  keep it that way.

Point `CRX_KEY_PATH` at it if you keep it outside the repo.

---

## For everyone else: installing

1. Download **`install-policy.reg`**.
2. Double-click it and accept the Windows prompt.
3. **Fully quit the browser** — every window, and check the system tray. A
   policy is only read at startup.
4. Reopen. The extension installs itself within a few seconds.

### Check it worked

Visit `chrome://policy` (or `edge://policy` / `brave://policy`) and press
**Reload policies**. You should see `ExtensionInstallForcelist` listed with the
extension id. If the policy shows but the extension hasn't appeared, give it a
minute — the browser fetches the package in the background.

### Uninstalling

Run `uninstall-policy.reg` and restart the browser. The extension is removed
automatically.

---

## Notes and limits

- **Windows only.** The `.reg` files write to `HKEY_CURRENT_USER`, so no
  administrator rights are needed and the policy applies to the logged-in user.
  For every account on a shared machine, change the hive to
  `HKEY_LOCAL_MACHINE` in `scripts/pack.mjs` — that does require elevation.
  macOS and Linux use the same policy under different mechanisms (a
  configuration profile / a JSON file under `/etc/opt/chrome/policies/managed/`);
  neither is generated here.
- **Verify Brave separately.** Brave is Chromium-based and reads Chromium
  policies, but it manages extensions more aggressively than Chrome does.
  Confirm at `brave://policy` on one machine before rolling out to everyone.
- **Updates aren't instant.** Browsers poll every few hours. To force one,
  open `chrome://extensions`, enable developer mode and press **Update**.
- **Some environments ignore registry policy.** Managed or hardened corporate
  devices may have conflicting policy from a domain or MDM, which wins.
  `chrome://policy` tells you what actually applied.
- This is unrelated to `npm run build:firefox`. Firefox needs a signed `.xpi`
  from addons.mozilla.org for permanent installation — see `HANDOVER.md`.
