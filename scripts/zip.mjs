// Package a built extension into a zip for hand-distribution.
//
//   npm run zip            → dist/         → release/watchparty-sync-<v>-chrome.zip
//   npm run zip:firefox    → dist-firefox/ → release/watchparty-sync-<v>-firefox.zip
//
// The manifest sits at the ROOT of the archive, not inside a `dist/` folder —
// that is what both extension stores require, and what makes the zip drop
// straight into "Load unpacked" after extracting.
//
// The zip is written here rather than shelled out to, because there is no
// portable zip command: Windows PowerShell's Compress-Archive has produced
// archives with the wrong path separators, macOS `zip` adds __MACOSX noise, and
// GNU tar cannot write zips at all. Node ships zlib, so the ~60 lines below cost
// less than a dependency and behave identically everywhere.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const TARGETS = {
  chrome: { dir: 'dist', suffix: 'chrome', build: 'npm run build' },
  firefox: { dir: 'dist-firefox', suffix: 'firefox', build: 'npm run build:firefox' },
};

const name = process.argv[2] ?? 'chrome';
const target = TARGETS[name];
if (!target) {
  console.error(`Unknown target "${name}". Use one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

// fileURLToPath rather than import.meta.dirname: the latter needs Node 20.11+,
// which would make this script demand a newer Node than the build itself (Vite
// accepts 18) — and it fails as "paths[0] must be of type string", which names
// nothing useful.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, target.dir);
const outDir = path.join(root, 'release');

if (!fs.existsSync(path.join(src, 'manifest.json'))) {
  console.error(`${target.dir}/manifest.json not found — run \`${target.build}\` first.`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')).version;
const outFile = path.join(outDir, `watchparty-sync-${version}-${target.suffix}.zip`);

// --- minimal zip writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Fixed DOS timestamp (1 Jan 2020) so rebuilding identical sources produces a
// byte-identical archive — handy when checking whether a rebuild changed
// anything at all.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/** Every file under `dir`, as archive-relative forward-slash paths. */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  });
}

function zipDir(dir) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const rel of walk(dir).sort()) {
    const raw = fs.readFileSync(path.join(dir, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Storing beats deflating when the file is already compressed (png, woff).
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(raw);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0, 6); // flags
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28); // extra length
    local.push(head, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += head.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const count = central.length / 2;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return { buffer: Buffer.concat([...local, cdBuf, end]), count };
}

// --- go ---------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
const { buffer, count } = zipDir(src);
fs.writeFileSync(outFile, buffer);

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
console.log(`\nwatchparty-sync ${version} (${target.suffix})`);
console.log(`  source  ${target.dir}/`);
console.log(`  zip     ${path.relative(root, outFile)}`);
console.log(`  ${count} files, ${kb(buffer.length)}`);
console.log(
  `\nExtract it and load the folder via ${
    name === 'firefox' ? 'about:debugging → Load Temporary Add-on' : 'chrome://extensions → Load unpacked'
  }.`,
);
