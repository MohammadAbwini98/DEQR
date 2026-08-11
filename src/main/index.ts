import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc-handlers';

function createWindow() {
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
      url.startsWith('http://localhost:5173')
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
