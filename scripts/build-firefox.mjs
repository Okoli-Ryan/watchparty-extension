// Produce a Firefox-compatible build from the Chrome/Edge output in dist/.
//
// CRXJS emits a Chrome MV3 manifest, and Chrome and Firefox differ in one
// structural way under MV3: Chrome runs the background as a service worker,
// while Firefox runs it as a non-persistent event page declared with
// `background.scripts`. Everything else in the bundle is shared, so we copy the
// build and patch the manifest rather than maintaining two builds.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'dist');
const out = path.join(root, 'dist-firefox');

if (!fs.existsSync(src)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const manifestPath = path.join(out, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// Service worker → event page. The CRXJS loader is a plain ES module import,
// which is exactly what Firefox's `background.scripts` + `type: module` wants.
const worker = manifest.background?.service_worker;
if (!worker) {
  console.error('No background.service_worker in the built manifest — nothing to convert.');
  process.exit(1);
}
manifest.background = { scripts: [worker], type: 'module' };

// Firefox requires a stable add-on id; without one, storage and session data
// are not reliably persisted across restarts.
manifest.browser_specific_settings = {
  gecko: {
    id: 'watchparty-sync@example.com',
    // MV3 background modules require a reasonably recent Firefox.
    strict_min_version: '121.0',
  },
};

// Firefox ignores `use_dynamic_url` and warns about it.
for (const entry of manifest.web_accessible_resources ?? []) {
  delete entry.use_dynamic_url;
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log('dist-firefox/ ready');
console.log('  background:', JSON.stringify(manifest.background));
console.log('  gecko id:  ', manifest.browser_specific_settings.gecko.id);
console.log('\nLoad via about:debugging → This Firefox → Load Temporary Add-on →');
console.log('select dist-firefox/manifest.json');
