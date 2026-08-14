import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { globalSessionManager } from './session-manager';
import {
  evaluateMediaPermission,
  isAllowedRendererRequest,
} from './development-request-policy';
import { pwaHostLifecycle } from './pwa-host-lifecycle';

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
    // The renderer provides the complete accessible title bar and window
    // controls. Keeping Electron's native frame would render a second header.
    frame: false,
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
    // The renderer this transfer was feeding is gone; its timers must not
    // outlive it waiting for a window that will never come back.
    globalSessionManager.disposeAll();
  });

  // A transfer interval is a Node timer, so closing the window does not stop
  // it. Left running it keeps encoding frames for a destroyed renderer, and its
  // `send` throws where nothing can catch it. Release the sessions with the
  // window that owns them.
  mainWindow.on('closed', () => {
    globalSessionManager.disposeAll();
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

// The iPhone receiver is not published at startup. It binds every interface and
// generates a private key on first use, so it waits for the person at the
// keyboard to ask for it through `pwaHost:start`.
app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Quitting can begin before any window closes, so this is not covered by the
  // window handler above.
  globalSessionManager.disposeAll();
  // A no-op when the host was never started, and it chains behind an in-flight
  // start so a half-open server cannot outlive the app.
  void pwaHostLifecycle.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
