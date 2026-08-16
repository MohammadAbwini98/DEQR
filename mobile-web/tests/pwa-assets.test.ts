import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

const exists = async (relative: string) =>
  access(path.join(root, 'public', relative)).then(() => true, () => false);

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

  it('ships every icon it advertises, and keeps the maskable one dedicated', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
    const html = await readFile(path.join(root, 'index.html'), 'utf8');

    // A manifest naming an icon that is not in `public/` installs a broken
    // Home Screen icon, and nothing else in the suite would notice.
    const declared = manifest.icons.map((icon: { src: string }) => icon.src.replace(/^\.\//, ''));
    const referenced = [...html.matchAll(/(?:href)="\.\/([^"]+\.(?:png|ico|svg))"/g)].map((match) => match[1]);
    for (const asset of new Set([...declared, ...referenced])) {
      expect(await exists(asset), `${asset} is referenced but not present`).toBe(true);
    }
    expect(referenced).toContain('icons/apple-touch-icon-180.png');
    expect(referenced).toContain('favicon.ico');

    // `purpose: "any maskable"` on a single file is the common mistake: the
    // platform mask crops it to a circle, so artwork drawn to fill the square
    // loses its edges. The maskable entry has to be its own inset artwork.
    const maskable = manifest.icons.filter((icon: { purpose?: string }) => icon.purpose?.split(' ').includes('maskable'));
    expect(maskable).toHaveLength(1);
    expect(maskable[0].purpose).toBe('maskable');
    expect(maskable[0].src).toBe('./icons/deqr-maskable-512.png');
  });

  it('registers the service worker only in a production build', async () => {
    const main = await readFile(path.join(root, 'src/main.tsx'), 'utf8');
    const launcher = await readFile(path.join(root, '..', 'scripts/run-local.ps1'), 'utf8');

    // The development server and the packaged receiver share origin :5174, so a
    // worker registered while developing keeps serving its cached development
    // shell once the packaged host owns the port. That shell requests
    // /src/main.tsx and /@vite/*, which the packaged host cannot serve, and the
    // page renders blank with 503s for files that never existed there.
    expect(launcher, 'the launcher still shares the receiver port').toMatch(/PwaPort\s*=\s*5174/);
    expect(main).toMatch(/import\.meta\.env\.PROD\s*&&\s*'serviceWorker' in navigator/);
    expect(main).not.toMatch(/^\s*if \('serviceWorker' in navigator\)/m);
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
