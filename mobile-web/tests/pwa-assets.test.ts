import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
describe('PWA shell', () => {
  it('declares standalone installability and an offline shell worker', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8')); const worker = await readFile(path.join(root, 'public/sw.js'), 'utf8');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: './icons/deqr-192.png', sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ src: './icons/deqr-512.png', sizes: '512x512', type: 'image/png' }),
      expect.objectContaining({ src: './icons/deqr.svg', sizes: 'any', type: 'image/svg+xml' }),
    ]));
    expect(worker).toContain('PRECACHE_URLS'); expect(worker).not.toContain('http://'); expect(worker).not.toContain('https://');
  });

  it('uses a local-only CSP and a Vite cache distinct from the Electron renderer', async () => {
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const pwaVite = await readFile(path.join(root, 'vite.config.ts'), 'utf8');
    const desktopVite = await readFile(path.join(root, '..', 'vite.config.ts'), 'utf8');

    expect(html).toContain("default-src 'self'");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/(?:^|;\s*)script-src[^;]*'unsafe-inline'/);
    expect(html).toContain("connect-src 'self'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain("frame-ancestors 'none'");
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).toContain('media="(prefers-color-scheme: light)"');
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
    expect(html).toContain('href="./icons/apple-touch-icon-180.png"');
    expect(pwaVite).toContain(".vite-mobile-web");
    expect(pwaVite).toMatch(/port:\s*5174/);
    expect(pwaVite).toMatch(/strictPort:\s*true/);
    expect(desktopVite).toContain(".vite-desktop-renderer");
    expect(pwaVite).not.toContain('.vite-desktop-renderer');
    expect(desktopVite).not.toContain('.vite-mobile-web');
  });
});
