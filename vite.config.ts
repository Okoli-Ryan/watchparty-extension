import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// CRXJS derives all entry points (popup, content script, service worker) from the
// manifest, so no manual rollupOptions.input is needed.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'esnext',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
