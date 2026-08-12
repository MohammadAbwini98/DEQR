import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

const certificate = process.env.DEQR_HTTPS_CERT;
const privateKey = process.env.DEQR_HTTPS_KEY;

if (Boolean(certificate) !== Boolean(privateKey)) {
  throw new Error('Set both DEQR_HTTPS_CERT and DEQR_HTTPS_KEY, or neither.');
}

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  base: './',
  // This app has a distinct dependency graph from the Electron renderer.
  // Store its optimizer output separately in the shared dependency root.
  cacheDir: path.resolve(__dirname, '../node_modules/.vite-mobile-web'),
  build: {
    // Built into the desktop `dist/` tree so electron-builder's existing
    // `dist/**/*` rule ships the receiver inside the packaged app, which serves
    // it over LAN HTTPS at runtime.
    outDir: path.resolve(__dirname, '../dist/pwa'),
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    // Vite React Fast Refresh injects an inline module into index.html.
    // A static CSP can therefore allow only external same-origin scripts when
    // development uses manual browser reloads instead.
    hmr: false,
    https: certificate && privateKey ? {
      cert: fs.readFileSync(certificate),
      key: fs.readFileSync(privateKey),
    } : undefined,
  },
});
