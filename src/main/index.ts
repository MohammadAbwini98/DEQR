import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, '../../dist/preload/index.js'),
    },
    autoHideMenuBar: true,
  });

  // Strict CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests"]
      }
    });
  });

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
    const url = webContents.getURL();
    const isTrusted = url.startsWith('file://') || url.startsWith('http://localhost:5173');

    if (permission === 'media' && isTrusted) {
      if (details.mediaTypes?.includes('video') && !details.mediaTypes.includes('audio')) {
        return callback(true);
      }
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const isTrusted = requestingOrigin.startsWith('file://') || requestingOrigin.startsWith('http://localhost:5173');
    if (permission === 'media' && isTrusted) {
      if (details.mediaTypes?.includes('video') && !details.mediaTypes.includes('audio')) {
        return true;
      }
    }
    return false;
  });

  // Strict Network Denial
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    // Allow devtools, data URIs, local files, and the local vite server
    if (
      url.startsWith('devtools:') || 
      url.startsWith('file:') || 
      url.startsWith('data:') || 
      url.startsWith('http://localhost:5173')
    ) {
      callback({ cancel: false });
    } else {
      console.warn('Blocked external network request:', url);
      callback({ cancel: true });
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
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
