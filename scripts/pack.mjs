// Package dist/ as a signed .crx plus the update manifest and registry files
// needed to install it through enterprise policy.
//
// WHY POLICY AND NOT A PLAIN .crx: Chrome and Edge refuse off-store .crx files
// dragged onto chrome://extensions — you get CRX_REQUIRED_PROOF_MISSING,
// because they require a Web Store signature this (or any) local tool cannot
// produce. Extensions installed through the ExtensionInstallForcelist policy are
// exempt from that check, so policy is the only working self-hosted route. It
// also brings automatic updates and drops the "developer mode" nag.
//
//   npm run build && npm run pack
//
// Outputs into release/:
//   watchparty-sync.crx   the signed package (upload as a release asset)
//   updates.xml           the update manifest (upload as a release asset)
//   install-policy.reg    per-user registry entries for Chrome/Edge/Brave
//   uninstall-policy.reg  removes them again

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crx3 = require('crx3');

try {
  process.loadEnvFile();
} catch {
  /* no .env — fall back to the ambient environment */
}

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release');

// The signing key IS the extension's identity: its hash becomes the extension
// id, and anyone holding it can publish an update that installed browsers will
// accept automatically. Generated once, then reused forever — a new key means a
// new id, which reads as a different extension and orphans every install.
const keyPath = process.env.CRX_KEY_PATH || path.join(root, 'key.pem');

const NAME = 'watchparty-sync';
const crxPath = path.join(outDir, `${NAME}.crx`);
const xmlPath = path.join(outDir, 'updates.xml');

// Where the browsers will fetch updates from. Defaults to the repo's GitHub
// releases, whose /latest/download/ URLs stay stable across releases.
const REPO = process.env.CRX_REPO || 'Okoli-Ryan/watchparty-extension';
const base = process.env.CRX_BASE_URL || `https://github.com/${REPO}/releases/latest/download`;
const crxURL = `${base}/${NAME}.crx`;
const updateURL = `${base}/updates.xml`;

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found — run `npm run build` first.');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version;
fs.mkdirSync(outDir, { recursive: true });

/**
 * The extension id Chrome derives from a key: SHA-256 of the DER public key,
 * first 16 bytes, hex mapped from 0-f onto a-p.
 */
function extensionId(privateKeyPem) {
  const pub = crypto
    .createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'der' });
  return crypto
    .createHash('sha256')
    .update(pub)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

/** Chromium policy roots. Same mechanism, one registry path per browser. */
const BROWSERS = [
  ['Chrome', 'Software\\Policies\\Google\\Chrome'],
  ['Edge', 'Software\\Policies\\Microsoft\\Edge'],
  ['Brave', 'Software\\Policies\\BraveSoftware\\Brave'],
];

// HKCU rather than HKLM: it needs no administrator rights and applies to the
// person actually running the browser. Swap to HKEY_LOCAL_MACHINE to cover
// every account on a shared machine (that does require elevation).
const HIVE = 'HKEY_CURRENT_USER';

function regFiles(id) {
  const entry = `${id};${updateURL}`;

  const install = [
    'Windows Registry Editor Version 5.00',
    '',
    '; WatchParty Sync — force-install via Chromium enterprise policy.',
    '; Double-click to apply, then FULLY restart the browser (close every window).',
    '; Verify at chrome://policy, edge://policy or brave://policy.',
    '',
    ...BROWSERS.flatMap(([name, key]) => [
      `; ${name}`,
      `[${HIVE}\\${key}\\ExtensionInstallForcelist]`,
      `"1"="${entry}"`,
      '',
    ]),
  ].join('\r\n');

  // Removes only our own value, so any other forced extension survives.
  const uninstall = [
    'Windows Registry Editor Version 5.00',
    '',
    '; Removes the WatchParty Sync policy entry. Restart the browser afterwards.',
    '; The extension is then uninstalled automatically.',
    '',
    ...BROWSERS.flatMap(([name, key]) => [
      `; ${name}`,
      `[${HIVE}\\${key}\\ExtensionInstallForcelist]`,
      '"1"=-',
      '',
    ]),
  ].join('\r\n');

  fs.writeFileSync(path.join(outDir, 'install-policy.reg'), install, 'utf8');
  fs.writeFileSync(path.join(outDir, 'uninstall-policy.reg'), uninstall, 'utf8');
}

const hadKey = fs.existsSync(keyPath);

await crx3([dist], { keyPath, crxPath, xmlPath, crxURL, appVersion: version });

const id = extensionId(fs.readFileSync(keyPath, 'utf8'));
regFiles(id);

console.log(`\n${NAME} ${version} packed`);
console.log(`  id        ${id}`);
console.log(`  crx       ${path.relative(root, crxPath)}`);
console.log(`  updates   ${path.relative(root, xmlPath)}`);
console.log(`  policy    release/install-policy.reg, release/uninstall-policy.reg`);
console.log(`  update    ${updateURL}`);

if (!hadKey) {
  console.log(
    `\n! A NEW signing key was generated at ${path.relative(root, keyPath)}.\n` +
      '  It is gitignored. Back it up somewhere safe and never share it: it is this\n' +
      "  extension's identity, and losing it means every existing install is orphaned\n" +
      '  (a new key produces a new id, which browsers treat as a different extension).',
  );
}

console.log('\nNext: create a GitHub release and attach BOTH release/watchparty-sync.crx');
console.log('and release/updates.xml, then send colleagues release/install-policy.reg.');
console.log('See INSTALL.md.');
