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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    https: certificate && privateKey ? {
      cert: fs.readFileSync(certificate),
      key: fs.readFileSync(privateKey),
    } : undefined,
  },
});
