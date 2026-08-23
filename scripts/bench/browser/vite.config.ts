/**
 * Phase 11 - a dev server for the real-OPFS certification page, and nothing else.
 *
 * Deliberately separate from `mobile-web/vite.config.ts`. The receiver's config
 * builds the shipped PWA, and a certification harness must not be able to end
 * up inside it: this one has its own root, so `mobile-web`'s single-entry build
 * cannot pick the page up, and no `build` block, because there is nothing here
 * to ship.
 *
 *   npx vite --config scripts/bench/browser/vite.config.ts
 *
 * `fs.allow` reaches back to the repository root because the page imports the
 * shipping receiver from `mobile-web/src` and the protocol from `src/core`.
 * Importing them is the whole point - a harness with its own copy of the
 * pipeline would certify the copy.
 */

import path from 'node:path';
import { defineConfig } from 'vite';

const repositoryRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  cacheDir: path.resolve(repositoryRoot, 'node_modules/.vite-phase11'),
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    // Not 5173 (the Electron renderer) and not 5174 (held by a running
    // deqr.exe serving the PWA over LAN HTTPS).
    port: 5312,
    strictPort: true,
    hmr: false,
    fs: { allow: [repositoryRoot] },
  },
});
