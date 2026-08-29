/**
 * Ownership and lifecycle for DEQR v2 streaming transfer sessions.
 *
 * The privileged side of the boundary. It holds the path, the file descriptor,
 * and the segment buffers; the renderer holds a session id, sanitized display
 * metadata, and one QR-ready frame at a time. Nothing here hands the renderer a
 * filesystem primitive, and no channel returns a path.
 *
 * **Frames are pulled, not pushed.** The renderer asks for the next frame when
 * it is ready to paint one, which makes display backpressure the natural state
 * rather than something the main process has to be told about. It also removes
 * the main-process timer the v1 sender needs — the timer that kept encoding for
 * a destroyed renderer and surfaced as a shutdown crash.
 *
 * 64-bit sizes cross the boundary as decimal strings. Structured clone can
 * carry a `BigInt`, but the renderer only ever formats these for display, and a
 * string cannot be accidentally coerced into a lossy `number` on the way.
 */

import { BrowserWindow, dialog } from 'electron';

import { DeqrError, ErrorCode } from '../shared/errors';
import type {
  StreamingFrameResult,
  StreamingProgressView,
  StreamingSelectOptions,
  StreamingSelectionResult,
  StreamingTransferMetadata,
} from '../shared/types';
import {
  DEFAULT_TRANSPORT_PROFILE,
  transportProfileById,
  type TransportProfile,
} from '../core/transport-profiles';
import {
  StreamingSenderConfig,
  StreamingTransferSession,
  configFromProfile,
  nodeFileOpener,
  SenderFileOpener,
} from './streaming-sender';

/**
 * Resolves a renderer-supplied profile id to a profile the sender may use.
 *
 * Two refusals, both silent and both falling back to the default. An id that
 * names no profile is a renderer bug or a stale build; an id that names a
 * profile which is not `productionSelectable` is `Experimental`, whose numbers
 * no camera has ever seen. Neither is worth failing a transfer over, and
 * neither may be honoured - the returned profile is echoed back in the metadata
 * so the screen shows what was actually opened rather than what was asked for.
 */
export function resolveTransportProfile(id: unknown): TransportProfile {
  if (typeof id !== 'number' || !Number.isInteger(id)) return DEFAULT_TRANSPORT_PROFILE;
  const profile = transportProfileById(id);
  if (!profile || !profile.productionSelectable) return DEFAULT_TRANSPORT_PROFILE;
  return profile;
}

interface RegisteredSession {
  session: StreamingTransferSession;
  controller: AbortController;
}

export class StreamingSessionRegistry {
  private readonly sessions = new Map<number, RegisteredSession>();
  private nextSessionId = 1;

  constructor(
    private readonly opener: SenderFileOpener = nodeFileOpener,
    private readonly configOverrides: Partial<StreamingSenderConfig> = {},
  ) {}

  /**
   * Prompts for a file and prepares a streaming session for it.
   *
   * The dialog result never leaves this process. Preflight streams the file
   * once to compute its digest, so the returned metadata can promise a hash
   * before the first frame is drawn.
   *
   * `resumeToken` is the forty characters a user carried from a phone that
   * already holds part of this file. It is passed straight through to the
   * session, which refuses it unless the selected file's digest and
   * segmentation both agree - so a wrong token is an error at selection time
   * rather than a corrupt file at the far end.
   *
   * `transportProfileId` chooses the optical profile. It is resolved here
   * rather than trusted: see `resolveTransportProfile`. Construction-time
   * `configOverrides` still win, so a test or a development harness that pinned
   * a configuration is not overridden by a renderer.
   */
  async selectFile(
    window: BrowserWindow,
    options: StreamingSelectOptions = {},
  ): Promise<StreamingSelectionResult | null> {
    const { resumeToken, transportProfileId } = options;
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: resumeToken ? 'Select the File to Resume' : 'Select File to Transfer',
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const profile = resolveTransportProfile(transportProfileId);
    const controller = new AbortController();
    const session = await StreamingTransferSession.open(
      result.filePaths[0],
      {
        ...configFromProfile(profile),
        ...this.configOverrides,
        ...(resumeToken === undefined ? {} : { resumeToken }),
      },
      this.opener,
      controller.signal,
    );

    const sessionId = this.nextSessionId++;
    this.sessions.set(sessionId, { session, controller });
    return { sessionId, metadata: describe(session) };
  }

  /**
   * The next frame, or null when the pass is done.
   *
   * A finished pass leaves the session registered so the renderer can still
   * read its final progress; `cancel` is what releases it.
   */
  async nextFrame(sessionId: number): Promise<StreamingFrameResult> {
    const { session } = this.require(sessionId);
    const frame = await session.take();
    return { frame, progress: viewProgress(session) };
  }

  /**
   * Starts a recovery pass on a session whose first pass has finished.
   *
   * Reachable precisely because `nextFrame` leaves a finished session
   * registered. Without this the recovery tail built in Phase 13 existed in
   * `StreamingTransferSession` and could be called by nothing: the sender
   * displayed its last frame, the renderer replaced the QR with a status card,
   * and a receiver still a few symbols short had no way to ask for more.
   *
   * Returns how many segments the tail will generate for, so the renderer can
   * say "recovering 3 segments" rather than starting something silent.
   */
  async beginRecovery(sessionId: number, targets?: readonly number[]): Promise<number> {
    const { session } = this.require(sessionId);
    return session.beginRecovery(targets);
  }

  progress(sessionId: number): StreamingProgressView {
    return viewProgress(this.require(sessionId).session);
  }

  /** Idempotent: cancelling an already-released session is not an error. */
  async cancel(sessionId: number): Promise<void> {
    const registered = this.sessions.get(sessionId);
    if (!registered) return;
    this.sessions.delete(sessionId);
    registered.controller.abort();
    await registered.session.dispose();
  }

  /** Releases every session and its descriptor. Safe to call on window close or quit. */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.cancel(id)));
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private require(sessionId: number): RegisteredSession {
    const registered = this.sessions.get(sessionId);
    if (!registered) {
      throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
    }
    return registered;
  }
}

function describe(session: StreamingTransferSession): StreamingTransferMetadata {
  return {
    filename: session.manifest.filename,
    originalSizeBytes: session.manifest.originalSize.toString(),
    sha256: session.preflight.sha256Hex,
    segmentCount: session.plan.segmentCount,
    segmentSizeBytes: session.manifest.segmentSizeBytes,
    symbolSizeBytes: session.manifest.symbolSizeBytes,
    sourceSymbolsTotal: session.preflight.sourceSymbolsTotal,
    sampledCompressionRatio: session.preflight.compressibility.ratio,
    transportSizeBytes: session.manifest.transportSize.toString(),
    compressionMode: session.manifest.compressionMode,
    compressionRatio: session.preflight.compression.ratio,
    compressionReason: session.preflight.compression.reason,
    compressionBytesPerSecond: session.preflight.compression.measureBytesPerSecond,
    preflightHashMs: session.preflight.hashMs,
    resumed: session.preflight.resumed,
    resumeFromSegment: session.preflight.resumeFromSegment,
    // From the manifest rather than from the request: this is the id that
    // actually went on the wire, after any fallback the resolver applied.
    transportProfileId: session.manifest.transportProfileId,
  };
}

function viewProgress(session: StreamingTransferSession): StreamingProgressView {
  const progress = session.progress();
  return {
    originalBytesTotal: progress.originalBytesTotal.toString(),
    transportBytesTotal: progress.transportBytesTotal.toString(),
    transportBytesCovered: progress.transportBytesCovered.toString(),
    bytesOnTheWire: progress.bytesOnTheWire.toString(),
    segmentCount: progress.segmentCount,
    segmentsCompleted: progress.segmentsCompleted,
    currentSegmentIndex: progress.currentSegmentIndex,
    framesEmitted: progress.framesEmitted,
    manifestFramesEmitted: progress.manifestFramesEmitted,
    sourceSymbolsEmitted: progress.sourceSymbolsEmitted,
    repairSymbolsEmitted: progress.repairSymbolsEmitted,
    recoverySymbolsEmitted: progress.recoverySymbolsEmitted,
    recovering: progress.recovering,
    complete: progress.complete,
    resumeFromSegment: progress.resumeFromSegment,
  };
}

export const globalStreamingSessions = new StreamingSessionRegistry();
