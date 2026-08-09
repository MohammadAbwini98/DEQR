import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

function createWindow() {
  const contentSecurityPolicy = app.isPackaged
    ? "default-src 'self' 'unsafe-inline' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : "default-src 'self' 'unsafe-inline' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:5173; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

  if (!app.isPackaged) {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('Desktop renderer loaded: http://localhost:5173/');

      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(`
          JSON.stringify({
            rootHtml: document.getElementById('root')?.innerHTML ?? null,
            rootText: document.getElementById('root')?.innerText ?? null,
            resources: performance.getEntriesByType('resource').map((entry) => entry.name),
          })
        `).then((state) => {
          console.log(`Desktop renderer state: ${state}`);
        }).catch((error) => {
          console.error(`Desktop renderer state probe failed: ${error.message}`);
        });
      }, 1_500);
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      console.error(`Desktop renderer load failed (main frame: ${isMainFrame}): ${validatedUrl} (${errorCode}: ${errorDescription})`);
    });

    mainWindow.webContents.on('console-message', (event) => {
      console.error(`Desktop renderer console [${event.level}] ${event.sourceId}:${event.lineNumber} ${event.message}`);
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
    const url = webContents.getURL();
    const isTrusted = url === 'http://localhost:5173/' || url.startsWith('file://'); // Strict origin check
    const isMainFrame = details.isMainFrame === true;

    if (permission === 'media' && isTrusted && isMainFrame) {
      const mediaDetails = details as any;
      if (mediaDetails.mediaTypes && mediaDetails.mediaTypes.includes('video') && !mediaDetails.mediaTypes.includes('audio')) {
        return callback(true);
      }
    }
    callback(false); // Default deny
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!webContents) {
      return false;
    }
    const url = webContents.getURL();
    // Validate both the requestingOrigin and the actual webContents URL
    const isOriginTrusted = requestingOrigin === 'http://localhost:5173' || requestingOrigin.startsWith('file://');
    const isUrlTrusted = url === 'http://localhost:5173/' || url.startsWith('file://');
    const isTrusted = isOriginTrusted && isUrlTrusted;
    
    const isMainFrame = details?.isMainFrame === true;

    if (permission === 'media' && isTrusted && isMainFrame) {
      const mediaDetails = details as any;
      if (mediaDetails.mediaTypes && mediaDetails.mediaTypes.includes('video') && !mediaDetails.mediaTypes.includes('audio')) {
        return true;
      }
    }
    return false; // Default deny
  });

  // Strict Network Denial
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    // Allow devtools, data URIs, local files, and the local vite server
    if (
      url.startsWith('devtools:') || 
      url.startsWith('file:') || 
      url.startsWith('data:') || 
      url.startsWith('http://localhost:5173') ||
      // Vite's development HMR transport is local-only; keep production
      // network denial unchanged.
      url.startsWith('ws://localhost:5173') ||
      url.startsWith('wss://localhost:5173')
    ) {
      callback({ cancel: false });
    } else {
      console.warn('Blocked external network request:', url);
      callback({ cancel: true });
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  } else {
    // In dev, load Vite
    mainWindow.loadURL('http://localhost:5173');
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
