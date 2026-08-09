import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import crypto from 'crypto';
import { globalSessionManager, SessionState } from './session-manager';
import { sanitizeError, ErrorCode, DeqrError } from '../shared/errors';
import { FountainEncoder } from '../core/fountain-encoder';
import { FountainDecoder } from '../core/fountain-decoder';
import { serializeFrame } from '../core/protocol';
import { deserializeContainer } from '../core/container';
import { computeSha256 } from '../core/hash';

export function registerIpcHandlers() {
  ipcMain.handle('windowControls:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('windowControls:maximizeOrRestore', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.restore() : win.maximize();
    }
  });
  ipcMain.handle('windowControls:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle('files:selectForTransfer', async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      return await globalSessionManager.selectFile(window);
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  ipcMain.handle('files:discardSelection', async (event, sessionId: number) => {
    globalSessionManager.removeSession(sessionId);
  });

  ipcMain.handle('transfer:start', async (event, sessionId: number) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeTransfer) {
        throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'Transfer already running');
      }

      session.encoder = new FountainEncoder(session.payload, 512, sessionId); // 512 block size, seed = sessionId
      
      session.activeTransfer = {
        intervalId: setInterval(() => generateFrame(event.sender, session), 1000 / 30), // Target 30fps
        framesGenerated: 0,
        startTime: Date.now()
      };
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  ipcMain.handle('transfer:pause', async (event, sessionId: number) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeTransfer) {
        clearInterval(session.activeTransfer.intervalId);
        session.activeTransfer.intervalId = null as any; // marked paused
      }
    } catch (e) {}
  });

  ipcMain.handle('transfer:resume', async (event, sessionId: number) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeTransfer && !session.activeTransfer.intervalId) {
        session.activeTransfer.intervalId = setInterval(() => generateFrame(event.sender, session), 1000 / 30);
      }
    } catch (e) {}
  });

  ipcMain.handle('transfer:cancel', async (event, sessionId: number) => {
    globalSessionManager.removeSession(sessionId);
  });

  // Loopback handlers
  ipcMain.handle('loopback:start', async (event, sessionId: number, options: any) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeLoopback) {
        throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'Loopback already running');
      }

      session.encoder = new FountainEncoder(session.payload, 512, sessionId);
      session.activeLoopback = {
        intervalId: setInterval(() => loopbackFrame(event.sender, session, options), 1000 / 60), // Target 60fps for loopback
        decoder: new FountainDecoder()
      };
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  ipcMain.handle('loopback:cancel', async (event, sessionId: number) => {
    // A renderer can emit cancel after a completed transfer removed its session.
    // Cancellation is intentionally idempotent, so this is not an IPC error.
    const session = globalSessionManager.findSession(sessionId);
    if (!session) return;
    if (session.activeLoopback) {
      clearInterval(session.activeLoopback.intervalId);
      session.activeLoopback = undefined;
    }
  });

  ipcMain.handle('receive:saveReceivedFile', async (event, containerData: Uint8Array, defaultName: string) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return false;

      // 1. Validate container & extract metadata
      const containerBuffer = Buffer.from(containerData);
      const container = deserializeContainer(containerBuffer);

      // 2. Validate cryptographic hash in Main
      const actualHash = computeSha256(container.payload);
      if (!actualHash.equals(container.metadata.sha256)) {
        console.error('Hash mismatch: Container payload does not match metadata SHA-256');
        return false;
      }

      // 3. Prompt user with sanitized filename from container
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: 'Save Received File',
        defaultPath: container.metadata.filename || defaultName
      });

      if (canceled || !filePath) return false;

      // 4. Atomic write via unique temp file
      const tmpPath = `${filePath}.${crypto.randomUUID()}.deqr.tmp`;
      try {
        await fs.promises.writeFile(tmpPath, container.payload);
        await fs.promises.rename(tmpPath, filePath);
      } catch (writeErr) {
        // Cleanup temp file if it exists and write/rename failed
        try {
          await fs.promises.unlink(tmpPath);
        } catch (cleanupErr) {
          // Ignore if it didn't exist
        }
        throw writeErr;
      }

      return true;
    } catch (e) {
      console.error('Failed to save file:', e);
      return false;
    }
  });
}

function generateFrame(webContents: Electron.WebContents, session: SessionState) {
  if (!session.encoder || !session.activeTransfer) return;
  
  const frame = session.encoder.nextFrame();
  const payload = serializeFrame(frame);
  
  session.activeTransfer.framesGenerated++;
  const stats = {
    framesGenerated: session.activeTransfer.framesGenerated,
    sourceBlocks: session.encoder.getBlockCount(),
    elapsedMs: Date.now() - session.activeTransfer.startTime,
    currentFps: 30 // hardcoded estimate for now
  };

  webContents.send(`transfer:frame:${session.id}`, payload, stats);
}

function loopbackFrame(webContents: Electron.WebContents, session: SessionState, options: any) {
  if (!session.encoder || !session.activeLoopback) return;
  
  const frame = session.encoder.nextFrame();
  
  // Track received locally on activeLoopback
  if (session.activeLoopback.receivedFrames === undefined) session.activeLoopback.receivedFrames = 0;
  
  // Simulate drops
  if (Math.random() < (options.lossPercentage || 0) / 100) return;

  session.activeLoopback.receivedFrames++;
  const decoder: FountainDecoder = session.activeLoopback.decoder;
  const isComplete = decoder.receiveFrame(frame);

  const stats = {
    receivedFrames: session.activeLoopback.receivedFrames,
    recoveredBlocks: decoder.getSolvedCount(),
    isComplete,
    verificationPassed: false,
    hashMatched: false
  };

  if (isComplete) {
    clearInterval(session.activeLoopback.intervalId);
    
    // verify
    try {
      const reconstructed = decoder.reconstructPayload();
      const matched = reconstructed.equals(session.payload);
      stats.verificationPassed = true;
      stats.hashMatched = matched;
    } catch (e) {
      stats.verificationPassed = false;
      stats.hashMatched = false;
    }
  }

  webContents.send(`loopback:stats:${session.id}`, stats);
}
