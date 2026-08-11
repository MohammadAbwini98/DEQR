import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import {
  evaluateMediaPermission,
  isAllowedRendererRequest,
} from './development-request-policy';
import { collectLanAddresses } from './lan-addresses';
import { resolvePwaCertificate } from './pwa-certificate';
import {
  PWA_HOST_DEFAULT_PORT,
  RunningPwaHost,
  setPwaHostStatus,
  startPwaHost,
} from './pwa-host';

const DEVELOPMENT_RENDERER_URL = 'http://localhost:5173/';
const STARTUP_DIAGNOSTICS_ENABLED = process.env.DEQR_STARTUP_DIAGNOSTICS === '1';
const PACKAGED_ACCEPTANCE_AUTOCLOSE_ENABLED = process.env.DEQR_PACKAGED_ACCEPTANCE_AUTOCLOSE === '1';
const PACKAGED_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; manifest-src 'self'";
const DEVELOPMENT_CONTENT_SECURITY_POLICY = "default-src 'self' 'unsafe-inline' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

interface RendererReadiness {
  dashboard: boolean;
  preloadBridge: boolean;
}

function redactFailureDescription(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 160);
}

function reportRendererLifecycle(event: string, detail = ''): void {
  const suffix = detail.length > 0 ? ` ${detail}` : '';
  console.error(`DEQR_RENDERER_${event}${suffix}`);
}

async function inspectRendererReadiness(webContents: Electron.WebContents): Promise<RendererReadiness> {
  return webContents.executeJavaScript(`
    (() => {
      const heading = document.querySelector('#root h1');
      const dashboard = heading?.textContent?.trim() === 'DEQR Optical Transfer';
      const preloadBridge = Boolean(
        window.deqr &&
        typeof window.deqr.files?.selectForTransfer === 'function' &&
        typeof window.deqr.transfer?.start === 'function' &&
        typeof window.deqr.receive?.saveReceivedFile === 'function'
      );
      return { dashboard, preloadBridge };
    })();
  `) as Promise<RendererReadiness>;
}

function waitForRendererReady(mainWindow: BrowserWindow): void {
  const deadline = Date.now() + 15_000;

  const probe = async (): Promise<void> => {
    if (mainWindow.isDestroyed()) {
      return;
    }

    try {
      const readiness = await inspectRendererReadiness(mainWindow.webContents);
      if (readiness.dashboard && readiness.preloadBridge) {
        console.log('DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available');
        if (app.isPackaged && PACKAGED_ACCEPTANCE_AUTOCLOSE_ENABLED) {
          console.log('DEQR_PACKAGED_ACCEPTANCE_COMPLETE readiness=ready exit=clean');
          setTimeout(() => app.quit(), 100);
        }
        return;
      }

      if (Date.now() >= deadline) {
        reportRendererLifecycle(
          'NOT_READY',
          `dashboard=${readiness.dashboard} preload=${readiness.preloadBridge}`,
        );
        return;
      }
    } catch {
      if (Date.now() >= deadline) {
        reportRendererLifecycle('NOT_READY', 'probe=unavailable');
        return;
      }
    }

    setTimeout(() => void probe(), 250);
  };

  void probe();
}

function createWindow() {
  const contentSecurityPolicy = app.isPackaged
    ? PACKAGED_CONTENT_SECURITY_POLICY
    : DEVELOPMENT_CONTENT_SECURITY_POLICY;

  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
    autoHideMenuBar: true,
  });

  // Strict CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy]
      }
    });
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (STARTUP_DIAGNOSTICS_ENABLED) {
      console.log(`DEQR_RENDERER_LOAD_FINISHED source=${app.isPackaged ? 'packaged-file' : 'desktop-vite'}`);
    }
    waitForRendererReady(mainWindow);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    reportRendererLifecycle(
      'LOAD_FAILED',
      `frame=${isMainFrame ? 'main' : 'sub'} code=${errorCode} reason=${redactFailureDescription(errorDescription)}`,
    );
  });

  mainWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
    reportRendererLifecycle('PRELOAD_FAILED', `type=${error.name}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    reportRendererLifecycle('PROCESS_GONE', `reason=${details.reason} exitCode=${details.exitCode}`);
  });

  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (event) => {
      if (STARTUP_DIAGNOSTICS_ENABLED) {
        // Renderer output can contain selected filenames or other user data, so
        // retain only its severity as a diagnostic signal.
        reportRendererLifecycle('CONSOLE', `level=${event.level}`);
      }
    });
  }

  // Navigation Denial
  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  // Popup Denial
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
  
  // Strict Permission Denial (allow only specific media)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (!webContents) {
      return callback(false);
    }
    callback(
      evaluateMediaPermission({
        permission,
        frameUrl: webContents.getURL(),
        isMainFrame: details.isMainFrame === true,
        mediaTypes: (details as { mediaTypes?: string[] }).mediaTypes,
      }),
    );
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!webContents) {
      return false;
    }
    // Validate both the requestingOrigin and the actual webContents URL.
    return evaluateMediaPermission({
      permission,
      frameUrl: webContents.getURL(),
      requestingOrigin,
      isMainFrame: details?.isMainFrame === true,
      mediaTypes: (details as { mediaTypes?: string[] }).mediaTypes,
    });
  });

  // Strict Network Denial
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRendererRequest(details.url, app.isPackaged)) {
      callback({ cancel: false });
    } else {
      console.warn('DEQR_NETWORK_REQUEST_BLOCKED');
      callback({ cancel: true });
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  } else {
    // In dev, load Vite
    void mainWindow.loadURL(DEVELOPMENT_RENDERER_URL);
  }
}

let pwaHost: RunningPwaHost | null = null;

/**
 * Serves the built iPhone receiver over LAN HTTPS so the phone can install and
 * use it without any development server. Failure here must never stop the
 * desktop sender from starting: the desktop app is still fully usable with a
 * receiver that was installed earlier.
 */
async function startPwaHosting(): Promise<void> {
  // dist/main/index.js -> dist/pwa
  const rootDirectory = path.join(__dirname, '..', 'pwa');

  try {
    const addresses = collectLanAddresses();
    const certificate = resolvePwaCertificate({
      storageDirectory: path.join(app.getPath('userData'), 'pwa-host'),
      addresses: addresses.map((entry) => entry.address),
    });

    pwaHost = await startPwaHost({
      rootDirectory,
      certificate: certificate.certificate,
      privateKey: certificate.privateKey,
      port: PWA_HOST_DEFAULT_PORT,
    });

    const port = pwaHost.port;
    const candidates = addresses.map((entry) => ({
      address: entry.address,
      interfaceName: entry.interfaceName,
      kind: entry.kind,
      url: `https://${entry.address}:${port}/`,
    }));

    setPwaHostStatus({
      running: true,
      url: candidates[0]?.url ?? `https://127.0.0.1:${port}/`,
      addresses: candidates,
      subjectAltNames: certificate.subjectAltNames,
      certificateSource: certificate.source,
      error: null,
    });

    console.log(
      `DEQR_PWA_HOST_READY port=${port} certificate=${certificate.source} interfaces=${candidates.length} preferred=${candidates[0]?.kind ?? 'loopback'}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    setPwaHostStatus({
      running: false,
      url: null,
      addresses: [],
      subjectAltNames: [],
      certificateSource: null,
      // Surfaced in the desktop UI, so it must stay free of paths and key material.
      error: 'The iPhone receiver could not be published on this network.',
    });
    console.warn(`DEQR_PWA_HOST_UNAVAILABLE reason=${reason}`);
  }
}

async function stopPwaHosting(): Promise<void> {
  const host = pwaHost;
  pwaHost = null;
  if (host) {
    await host.close();
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  void startPwaHosting();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  void stopPwaHosting();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
