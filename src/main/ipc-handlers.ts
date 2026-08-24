import { app, ipcMain, BrowserWindow, dialog } from 'electron';
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
import { isBlockedExtension, sanitizeFilename } from '../core/filename-sanitizer';
import { RECEIVER_POLICY } from '../core/receiver-policy';
import { getPwaHostStatus, subscribePwaHostStatus } from './pwa-host';
import { pwaHostLifecycle } from './pwa-host-lifecycle';
import { globalStreamingSessions } from './streaming-session-registry';
import { isTrustedIpcSender } from './ipc-sender-policy';

// The browser receiver serially samples full camera frames at roughly 11 Hz
// before decode cost. Keep the sender below that ceiling until physical-device
// measurements establish a safe higher rate.
const DEFAULT_OPTICAL_TRANSFER_FPS = 10;
const OPTICAL_TRANSFER_INTERVAL_MS = 1_000 / DEFAULT_OPTICAL_TRANSFER_FPS;

/**
 * A renderer-supplied session id, or `null` for anything that cannot be one.
 *
 * Session ids are minted here and handed out; they are always positive safe
 * integers. A renderer that sends a string, an object or `NaN` is either a
 * defect or something that should not be talking to this channel, and either
 * way the answer is the same as for an id that has expired - which is what the
 * `null` return lets each handler express in its own terms rather than by
 * throwing from a place the caller cannot distinguish.
 */
function asSessionId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Loss simulation percentage from a renderer-supplied loopback options object.
 *
 * `options` was read as `any` inside a `setInterval` callback until Phase 10,
 * so `loopback:start` with `null` - or with `lossPercentage: {}` - produced a
 * throw in a timer, which reaches no caller and surfaces as Electron's "A
 * JavaScript error occurred in the main process" dialog. Clamped rather than
 * refused: this is a development aid, and the honest reading of a nonsensical
 * value is no simulated loss at all.
 */
export function readLossPercentage(options: unknown): number {
  if (typeof options !== 'object' || options === null) return 0;
  const value = (options as { lossPercentage?: unknown }).lossPercentage;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Registers a handler that runs only for a trusted top-level renderer frame.
 *
 * Every renderer-to-main channel goes through here. There is no exempt tier:
 * window controls were considered for one and rejected, because a frame that
 * should not be starting a LAN listener should not be closing the window
 * mid-transfer either, and an exemption needs a reason rather than an absence
 * of harm. Wrapping registration rather than each body is what makes an
 * unguarded handler hard to add by accident; `ipc-sender-policy.test.ts`
 * enumerates whatever this registers and proves each channel rejects.
 */
function handleTrusted(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event, app.isPackaged)) {
      // The channel name is static application structure. The frame URL is not
      // logged: it can carry a local filesystem path.
      console.warn(`DEQR_IPC_REJECTED channel=${channel}`);
      throw new DeqrError(ErrorCode.IPC_SENDER_REJECTED, 'IPC request rejected.');
    }
    return handler(event, ...args);
  });
}

export function registerIpcHandlers() {
  handleTrusted('windowControls:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  handleTrusted('windowControls:maximizeOrRestore', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.restore() : win.maximize();
    }
  });
  handleTrusted('windowControls:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Read-only view of the LAN receiver publication. It carries no key material
  // and no filesystem paths, so the renderer can display it directly.
  handleTrusted('pwaHost:getStatus', () => getPwaHostStatus());

  // Returns the acknowledgement (normally `starting`), not the outcome. The
  // outcome arrives on `pwaHost:status`, which matters because the card can
  // unmount while the host is still starting.
  handleTrusted('pwaHost:start', () => pwaHostLifecycle.start());
  handleTrusted('pwaHost:stop', () => pwaHostLifecycle.stop());

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

  handleTrusted('files:selectForTransfer', async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      return await globalSessionManager.selectFile(window);
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  /**
   * DEQR v2 streaming sender.
   *
   * Pull-based on purpose. There is no main-process timer pushing frames at a
   * renderer that may not be painting them, which is both real backpressure and
   * one fewer timer to outlive a window.
   */
  handleTrusted('streamTransfer:select', async (event, options?: unknown) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return null;
      // Everything in this object came from the renderer, so nothing is read
      // off it without a type check. The resume code is untrusted text on its
      // way to a parser that expects forty characters, so it is bounded here
      // and only forwarded when it is a string at all; the codec itself rejects
      // anything that is not a well-formed token. The profile id is bounded by
      // `resolveTransportProfile`, which falls back rather than failing.
      const request = typeof options === 'object' && options !== null
        ? options as { resumeToken?: unknown; transportProfileId?: unknown }
        : {};
      const token = typeof request.resumeToken === 'string'
        && request.resumeToken.length > 0
        && request.resumeToken.length <= RECEIVER_POLICY.maxResumeTokenChars
        ? request.resumeToken
        : undefined;
      const transportProfileId = typeof request.transportProfileId === 'number'
        ? request.transportProfileId
        : undefined;
      return await globalStreamingSessions.selectFile(window, { resumeToken: token, transportProfileId });
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  handleTrusted('streamTransfer:nextFrame', async (_event, rawSessionId: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) {
        throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
      }
      return await globalStreamingSessions.nextFrame(sessionId);
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  handleTrusted('streamTransfer:progress', async (_event, rawSessionId: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) return null;
      return globalStreamingSessions.progress(sessionId);
    } catch {
      // Progress for a session that is gone is not an error worth surfacing.
      return null;
    }
  });

  handleTrusted('streamTransfer:beginRecovery', async (_event, rawSessionId: unknown, rawTargets?: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) {
        throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
      }
      // Segment indices come from the renderer, so nothing is read off them
      // without a check. `beginRecovery` bounds them again against the plan and
      // refuses an empty or wholly out-of-range set rather than recovering
      // everything on a bad argument.
      const targets = Array.isArray(rawTargets)
        ? rawTargets.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0)
        : undefined;
      return await globalStreamingSessions.beginRecovery(sessionId, targets);
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  handleTrusted('streamTransfer:cancel', async (_event, rawSessionId: unknown) => {
    const sessionId = asSessionId(rawSessionId);
    if (sessionId === null) return;
    await globalStreamingSessions.cancel(sessionId);
  });

  handleTrusted('files:discardSelection', async (event, rawSessionId: unknown) => {
    const sessionId = asSessionId(rawSessionId);
    if (sessionId === null) return;
    globalSessionManager.removeSession(sessionId);
  });

  handleTrusted('transfer:start', async (event, rawSessionId: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) {
        throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
      }
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

  handleTrusted('transfer:pause', async (event, rawSessionId: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) return;
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

  handleTrusted('transfer:resume', async (event, rawSessionId: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) return;
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

  handleTrusted('transfer:cancel', async (event, rawSessionId: unknown) => {
    const sessionId = asSessionId(rawSessionId);
    if (sessionId === null) return;
    globalSessionManager.removeSession(sessionId);
  });

  // Loopback handlers
  handleTrusted('loopback:start', async (event, rawSessionId: unknown, options: unknown) => {
    try {
      const sessionId = asSessionId(rawSessionId);
      if (sessionId === null) {
        throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
      }
      const session = globalSessionManager.getSession(sessionId);
      if (session.activeLoopback) {
        throw new DeqrError(ErrorCode.INVALID_TRANSFER_STATE, 'Loopback already running');
      }

      // Read once, at the boundary, into a number. The timer below runs for the
      // life of the loopback and nothing inside it may touch renderer-supplied
      // structure again: a throw in a timer callback reaches no caller.
      const lossPercentage = readLossPercentage(options);
      session.encoder = new FountainEncoder(session.payload, V1_FOUNTAIN_BLOCK_SIZE_BYTES, sessionId);
      session.activeLoopback = {
        intervalId: setInterval(() => loopbackFrame(event.sender, session, lossPercentage), 1000 / 60), // Target 60fps for loopback
        decoder: new FountainDecoder()
      };
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  handleTrusted('loopback:cancel', async (event, rawSessionId: unknown) => {
    // A renderer can emit cancel after a completed transfer removed its session.
    // Cancellation is intentionally idempotent, so this is not an IPC error.
    const sessionId = asSessionId(rawSessionId);
    const session = sessionId === null ? undefined : globalSessionManager.findSession(sessionId);
    if (!session) return;
    if (session.activeLoopback) {
      clearInterval(session.activeLoopback.intervalId);
      session.activeLoopback = undefined;
    }
  });

  handleTrusted('receive:saveReceivedFile', async (event, containerData: unknown, defaultName: unknown) => {
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

      // 3. Prompt user with sanitized filename from container.
      //
      // The fallback is renderer-supplied and is sanitized to a bare basename
      // before it is used. `defaultPath` accepts an absolute path, so an
      // unsanitized fallback would let the renderer choose which directory the
      // save dialog opened in and what it was pre-filled with - the user still
      // confirms, but a dialog pre-aimed at a system directory is not a dialog
      // anyone reads carefully.
      const fallbackName = typeof defaultName === 'string' && defaultName.length > 0
        ? sanitizeFilename(defaultName)
        : 'received-file';
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: 'Save Received File',
        defaultPath: container.metadata.filename || fallbackName
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

/**
 * Whether a renderer can still receive IPC.
 *
 * Destroying a BrowserWindow destroys its WebContents, so this covers a closed
 * window as well as a gone renderer, and it tests the object whose `send`
 * actually throws. The call itself is guarded because a sufficiently torn-down
 * native handle can throw from `isDestroyed` too.
 */
function isRendererAlive(webContents: Electron.WebContents | undefined): boolean {
  if (!webContents) return false;
  try {
    return !webContents.isDestroyed();
  } catch {
    return false;
  }
}

/**
 * Delivers a frame to a renderer that is still there, and ends the session when
 * it is not.
 *
 * Transfer timers outlive the window: the interval is a Node timer, so it keeps
 * firing while Electron tears the renderer down, and a throw from inside a timer
 * callback reaches no caller — it surfaces as Electron's "A JavaScript error
 * occurred in the main process" dialog. Checking liveness is the fix; the catch
 * is only a floor under a destruction that lands between the check and the send.
 */
function deliverToRenderer(
  webContents: Electron.WebContents,
  session: SessionState,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!isRendererAlive(webContents)) {
    // Nothing will ever observe this session again, so stop encoding for it.
    globalSessionManager.removeSession(session.id);
    return false;
  }

  try {
    webContents.send(channel, ...args);
    return true;
  } catch {
    globalSessionManager.removeSession(session.id);
    return false;
  }
}

function generateFrame(webContents: Electron.WebContents, session: SessionState) {
  if (!session.encoder || !session.activeTransfer) return;
  if (!isRendererAlive(webContents)) {
    globalSessionManager.removeSession(session.id);
    return;
  }

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

  deliverToRenderer(webContents, session, `transfer:frame:${session.id}`, payload, stats);
}

function loopbackFrame(
  webContents: Electron.WebContents,
  session: SessionState,
  lossPercentage: number,
) {
  if (!session.encoder || !session.activeLoopback) return;
  if (!isRendererAlive(webContents)) {
    globalSessionManager.removeSession(session.id);
    return;
  }

  const frame = session.encoder.nextFrame();

  // Track received locally on activeLoopback
  if (session.activeLoopback.receivedFrames === undefined) session.activeLoopback.receivedFrames = 0;

  // Simulate drops. Already validated and clamped at the IPC boundary; this is
  // a number by the time it reaches a timer.
  if (Math.random() < lossPercentage / 100) return;

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

  deliverToRenderer(webContents, session, `loopback:stats:${session.id}`, stats);

  // Send final state before releasing the container bytes. The renderer may
  // follow completion with an idempotent cancel request, which then observes
  // the session as already removed.
  if (isComplete) {
    globalSessionManager.removeSession(session.id);
  }
}
