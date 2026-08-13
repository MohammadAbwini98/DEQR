import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');

async function readPackage(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;
}

async function readMainSource(): Promise<string> {
  return readFile(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
}

describe('packaged Electron security contract', () => {
  it('configures the required production Electron fuses explicitly', async () => {
    const packageJson = await readPackage();

    expect(packageJson.build?.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      // The packaged renderer currently loads through BrowserWindow.loadFile(file://).
      // Keep this enabled until that renderer moves to a privileged custom protocol.
      grantFileProtocolExtraPrivileges: true,
    });
  });

  it('builds and ships the iPhone receiver inside the packaged application', async () => {
    const packageJson = await readPackage();
    const pwaViteConfig = await readFile(
      path.join(root, 'mobile-web', 'vite.config.ts'),
      'utf8',
    );

    // The packaged app serves the receiver itself, so the PWA must be built
    // into the desktop dist tree and covered by the electron-builder file rule.
    expect(pwaViteConfig).toMatch(/outDir:\s*path\.resolve\(__dirname,\s*'\.\.\/dist\/pwa'\)/);
    expect(packageJson.build?.files).toContain('dist/**/*');
    for (const script of ['package', 'dist'] as const) {
      expect(packageJson.scripts?.[script]).toContain('mobile-web:build');
    }
  });

  it('uses a packaged deny-by-default CSP without inline script execution', async () => {
    const source = await readMainSource();
    const match = source.match(/const PACKAGED_CONTENT_SECURITY_POLICY = "([^"]+)";/);

    expect(match, 'packaged CSP constant must remain statically reviewable').not.toBeNull();
    const directives = match![1].split('; ').map((directive) => directive.trim());

    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("script-src 'self'");
    expect(directives).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(directives).toContain("style-src 'self' 'unsafe-inline'");
    expect(directives).toContain("worker-src 'self' blob:");
    expect(directives).toContain("connect-src 'none'");
    expect(directives).toContain("object-src 'none'");
    expect(directives).toContain("frame-src 'none'");
    expect(directives).toContain("frame-ancestors 'none'");
  });

  it('emits packaged readiness and only auto-closes behind the exact acceptance gate', async () => {
    const source = await readMainSource();

    expect(source).toContain("process.env.DEQR_PACKAGED_ACCEPTANCE_AUTOCLOSE === '1'");
    expect(source).toContain('DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available');
    expect(source).toContain('app.isPackaged && PACKAGED_ACCEPTANCE_AUTOCLOSE_ENABLED');
    expect(source).toContain('DEQR_PACKAGED_ACCEPTANCE_COMPLETE readiness=ready exit=clean');
    expect(source).toContain('setTimeout(() => app.quit(), 100)');

    const readinessRegistration = source.indexOf("mainWindow.webContents.on('did-finish-load'");
    const developmentOnlyRegistration = source.indexOf('if (!app.isPackaged)');
    expect(readinessRegistration).toBeGreaterThan(-1);
    expect(readinessRegistration).toBeLessThan(developmentOnlyRegistration);
  });

  it('never publishes the iPhone receiver until someone asks for it', async () => {
    const source = await readMainSource();

    // The receiver binds every interface and writes a private key on first use.
    // Off by default is enforced here as the absence of any startup call.
    expect(source).not.toMatch(/startPwaHosting/);
    expect(source).not.toMatch(/startPwaHost\(/);
    expect(source).toMatch(
      /whenReady\(\)\.then\(\(\) => \{\s*registerIpcHandlers\(\);\s*createWindow\(\);/,
    );
    // A running host must still be closed on the way out.
    expect(source).toContain("app.on('before-quit'");
    expect(source).toContain('pwaHostLifecycle.stop()');
  });
});
