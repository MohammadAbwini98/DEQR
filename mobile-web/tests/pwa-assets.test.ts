import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
describe('PWA shell', () => {
  it('declares standalone installability and an offline shell worker', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8')); const worker = await readFile(path.join(root, 'public/sw.js'), 'utf8');
    expect(manifest.display).toBe('standalone'); expect(manifest.icons[0].src).toContain('deqr.svg'); expect(worker).toContain('PRECACHE_URLS'); expect(worker).not.toContain('http://'); expect(worker).not.toContain('https://');
  });
});
