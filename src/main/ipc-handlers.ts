import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import {
  globalSessionManager,
  SessionState,
  V1_FOUNTAIN_BLOCK_SIZE_BYTES,
  V1_MAX_SERIALIZED_CONTAINER_BYTES,
} from './session-manager';
import { sanitizeError, ErrorCode, DeqrError } from '../shared/errors';
import type { TransferStats } from '../shared/types';
import { FountainEncoder } from '../core/fountain-encoder';
import { FountainDecoder } from '../core/fountain-decoder';
import { serializeFrame } from '../core/protocol';
import { deserializeContainer } from '../core/container';
import { computeSha256 } from '../core/hash';
import { isBlockedExtension } from '../core/filename-sanitizer';
import { getPwaHostStatus, subscribePwaHostStatus } from './pwa-host';
import { pwaHostLifecycle } from './pwa-host-lifecycle';

// The browser receiver serially samples full camera frames at roughly 11 Hz
// before decode cost. Keep the sender below that ceiling until physical-device
// measurements establish a safe higher rate.
const DEFAULT_OPTICAL_TRANSFER_FPS = 10;
const OPTICAL_TRANSFER_INTERVAL_MS = 1_000 / DEFAULT_OPTICAL_TRANSFER_FPS;

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

  // Read-only view of the LAN receiver publication. It carries no key material
  // and no filesystem paths, so the renderer can display it directly.
  ipcMain.handle('pwaHost:getStatus', () => getPwaHostStatus());

  // Returns the acknowledgement (normally `starting`), not the outcome. The
  // outcome arrives on `pwaHost:status`, which matters because the card can
  // unmount while the host is still starting.
  ipcMain.handle('pwaHost:start', () => pwaHostLifecycle.start());
  ipcMain.handle('pwaHost:stop', () => pwaHostLifecycle.stop());

  // The first app-scoped push channel here; the others are per-session
  // (`transfer:frame:${id}`, `loopback:stats:${id}`). Registration happens once
  // because `registerIpcHandlers` is called once.
  subscribePwaHostStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('pwaHost:status', status);
      }
    }
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

      session.encoder = new FountainEncoder(session.payload, V1_FOUNTAIN_BLOCK_SIZE_BYTES, sessionId);

      session.activeTransfer = {
        intervalId: null,
        framesGenerated: 0,
        elapsedActiveMs: 0,
        activeSinceMs: performance.now()
      };
      session.activeTransfer.intervalId = setInterval(
        () => generateFrame(event.sender, session),
        OPTICAL_TRANSFER_INTERVAL_MS,
      );
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  ipcMain.handle('transfer:pause', async (event, sessionId: number) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeTransfer) {
        if (session.activeTransfer.intervalId !== null) {
          const now = performance.now();
          if (session.activeTransfer.activeSinceMs !== null) {
            session.activeTransfer.elapsedActiveMs += now - session.activeTransfer.activeSinceMs;
          }
          session.activeTransfer.activeSinceMs = null;
          clearInterval(session.activeTransfer.intervalId);
          session.activeTransfer.intervalId = null;
        }
      }
    } catch (e) {}
  });

  ipcMain.handle('transfer:resume', async (event, sessionId: number) => {
    try {
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeTransfer && !session.activeTransfer.intervalId) {
        session.activeTransfer.activeSinceMs = performance.now();
        session.activeTransfer.intervalId = setInterval(
          () => generateFrame(event.sender, session),
          OPTICAL_TRANSFER_INTERVAL_MS,
        );
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

      session.encoder = new FountainEncoder(session.payload, V1_FOUNTAIN_BLOCK_SIZE_BYTES, sessionId);
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

  ipcMain.handle('receive:saveReceivedFile', async (event, containerData: unknown, defaultName: string) => {
    let containerBuffer: Buffer | undefined;
    let containerPayload: Buffer | undefined;
    let expectedHash: Buffer | undefined;
    let actualHash: Buffer | undefined;

    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return false;

      if (!(containerData instanceof Uint8Array)) {
        console.warn('DEQR_RECEIVE_REJECTED reason=invalid_container_type');
        return false;
      }

      if (containerData.byteLength > V1_MAX_SERIALIZED_CONTAINER_BYTES) {
        console.warn('DEQR_RECEIVE_REJECTED reason=container_too_large');
        return false;
      }

      // 1. Validate container & extract metadata
      // Buffer.from(Uint8Array) makes a private copy so cleanup never mutates
      // the renderer-owned structured-clone input.
      containerBuffer = Buffer.from(containerData);
      const container = deserializeContainer(containerBuffer);
      containerPayload = container.payload;
      expectedHash = container.metadata.sha256;

      if (isBlockedExtension(container.metadata.filename)) {
        console.warn('DEQR_RECEIVE_REJECTED reason=blocked_extension');
        return false;
      }

      // 2. Validate cryptographic hash in Main
      actualHash = computeSha256(containerPayload);
      if (!actualHash.equals(expectedHash)) {
        console.error('DEQR_RECEIVE_REJECTED reason=hash_mismatch');
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
        // IPC provides a structured-clone snapshot. Write the validated payload
        // range from that immutable-to-main input so no additional sensitive
        // write buffer is created; main-owned parse/hash copies are wiped below.
        const payloadOffset = containerBuffer.byteLength - containerPayload.byteLength;
        await fs.promises.writeFile(
          tmpPath,
          containerData.subarray(payloadOffset, payloadOffset + containerPayload.byteLength),
        );
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
    } catch {
      console.error('DEQR_RECEIVE_FAILED');
      return false;
    } finally {
      actualHash?.fill(0);
      expectedHash?.fill(0);
      containerPayload?.fill(0);
      containerBuffer?.fill(0);
    }
  });
}

function generateFrame(webContents: Electron.WebContents, session: SessionState) {
  if (!session.encoder || !session.activeTransfer) return;
  
  const frame = session.encoder.nextFrame();
  const payload = serializeFrame(frame);
  
  const transfer = session.activeTransfer;
  transfer.framesGenerated++;
  const activeElapsedMs = transfer.elapsedActiveMs + (
    transfer.activeSinceMs === null ? 0 : performance.now() - transfer.activeSinceMs
  );
  const elapsedMs = Math.max(0, Math.round(activeElapsedMs));
  const stats: TransferStats = {
    framesGenerated: transfer.framesGenerated,
    sourceBlocks: session.encoder.getBlockCount(),
    elapsedMs,
    targetFps: DEFAULT_OPTICAL_TRANSFER_FPS,
    effectiveFps: elapsedMs > 0 ? transfer.framesGenerated * 1_000 / elapsedMs : 0,
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

  // Send final state before releasing the container bytes. The renderer may
  // follow completion with an idempotent cancel request, which then observes
  // the session as already removed.
  if (isComplete) {
    globalSessionManager.removeSession(session.id);
  }
}
