import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

describe('local launcher contract', () => {
  it('keeps desktop and PWA development servers isolated and verifies response markers', async () => {
    const launcher = await readFile(path.join(root, 'scripts', 'run-local.ps1'), 'utf8');
    const desktopVite = await readFile(path.join(root, 'vite.config.ts'), 'utf8');
    const pwaVite = await readFile(path.join(root, 'mobile-web', 'vite.config.ts'), 'utf8');

    expect(launcher).toContain('[int]$PwaPort = 5174');
    expect(launcher).toContain("$desktopPort = 5173");
    expect(launcher).toContain("if ($PwaPort -eq $desktopPort)");
    expect(launcher).toContain('function Assert-DesktopServerReady');
    expect(launcher).toContain('function Assert-PwaServerReady');
    expect(launcher).toContain("'DEQR Receive'");
    expect(launcher).toContain("'buffer'");
    expect(launcher).toContain('npm.cmd run dev -- --port 5173 --strictPort');
    expect(launcher).toContain('npm.cmd run mobile-web:dev -- --port $PwaPort --strictPort');
    expect(desktopVite).toContain('.vite-desktop-renderer');
    expect(pwaVite).toContain('.vite-mobile-web');
  });

  it('requires a renderer-ready marker before reporting success and tears down launched children', async () => {
    const launcher = await readFile(path.join(root, 'scripts', 'run-local.ps1'), 'utf8');

    expect(launcher).toContain("$readyMarker = 'DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available'");
    expect(launcher).toContain("Write-Host 'CURRENT STATUS: RUNNING'");
    expect(launcher).toContain('Stop-ProcessTree -Process $electron');
    expect(launcher).toContain('Stop-ProcessTree -Process $pwaVite');
    expect(launcher).toContain('Stop-ProcessTree -Process $desktopVite');
  });
});
