import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The web dashboard is a plain SPA, built from the SAME npm package as the
// extension so it can import `src/firebase/*` and `src/shared/crypto.ts`
// directly. That is not a convenience: chat is encrypted, and a second copy of
// the crypto could drift from the extension's and silently fail to decrypt.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export default defineConfig({
  root: here,
  plugins: [react()],
  // .env lives at the repo root, next to the extension's — one set of VITE_FB_*
  // values serves both, so they always point at the same Firebase project.
  envDir: repoRoot,
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    // Imports reach outside `root` into ../src; the dev server has to allow it.
    fs: { allow: [repoRoot] },
  },
});
