import { dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { computeSha256 } from '../core/hash';
import { sanitizeFilename, isBlockedExtension } from '../core/filename-sanitizer';
import { ErrorCode, DeqrError } from '../shared/errors';
import { SafeDisplayMetadata } from '../shared/types';
import { FountainEncoder } from '../core/fountain-encoder';
import { PROTOCOL_VERSION, serializeContainer } from '../core/container';

// Version 1 encodes a single, unsegmented container. Keep these values aligned
// with the frame header's uint16 block-count field and the sender's fixed
// payload block size; changing either requires a protocol version change.
export const V1_FOUNTAIN_BLOCK_SIZE_BYTES = 512;
export const V1_MAX_BLOCK_COUNT = 65_535;
export const V1_MAX_SERIALIZED_CONTAINER_BYTES =
  V1_FOUNTAIN_BLOCK_SIZE_BYTES * V1_MAX_BLOCK_COUNT;

export interface SessionState {
  id: number;
  filepath: string;
  metadata: SafeDisplayMetadata;
  payload: Buffer;
  encoder?: FountainEncoder;
  activeTransfer?: {
    intervalId: NodeJS.Timeout | null;
    framesGenerated: number;
    elapsedActiveMs: number;
    activeSinceMs: number | null;
  };
  activeLoopback?: {
    intervalId: NodeJS.Timeout;
    decoder: any; // We'll implement decoder in loopback-manager
    receivedFrames?: number;
  };
}

export class SessionManager {
  private sessions = new Map<number, SessionState>();
  private nextSessionId = 1;
  public async selectFile(window: BrowserWindow): Promise<{ sessionId: number; metadata: SafeDisplayMetadata } | null> {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Select File to Transfer',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null; // Return null instead of throwing error for cancel
    }

    const filepath = result.filePaths[0];
    const stat = fs.statSync(filepath);

    if (!stat.isFile()) {
      throw new DeqrError(ErrorCode.FILE_NOT_REGULAR, 'Selected path is not a regular file');
    }

    // A source at or above the total transport capacity cannot fit after the
    // required DEQR container metadata is added. The exact serialized check
    // below remains authoritative for smaller sources.
    if (stat.size >= V1_MAX_SERIALIZED_CONTAINER_BYTES) {
      throw new DeqrError(
        ErrorCode.FILE_TOO_LARGE,
        'This file exceeds the DEQR v1 optical transfer capacity. Select a smaller file.',
      );
    }

    const parsedPath = path.parse(filepath);
    const sanitizedName = sanitizeFilename(parsedPath.base);
    
    if (isBlockedExtension(sanitizedName)) {
      throw new DeqrError(ErrorCode.FILE_TYPE_BLOCKED, 'File extension is blocked by security policy');
    }

    // The fountain stream transports a complete DEQR container, never the raw
    // source file. Receivers need this metadata to validate and safely save it.
    const sourcePayload = fs.readFileSync(filepath);
    let payload: Buffer | undefined;
    try {
      const sha256 = computeSha256(sourcePayload);

      // In a real implementation, we would try to compress here and check if it's beneficial.
      // For M1, we skip compression to keep the flow simple, but report it.
      const metadata: SafeDisplayMetadata = {
        filename: sanitizedName,
        extension: parsedPath.ext.replace('.', ''),
        size: stat.size,
        mimeType: 'application/octet-stream', // Generic fallback
        sha256: sha256.toString('hex'),
        compressed: false
      };

      payload = serializeContainer({
        metadata: {
          protocolVersion: PROTOCOL_VERSION,
          filename: sanitizedName,
          mimeType: metadata.mimeType,
          originalSize: sourcePayload.length,
          compressed: false,
          encrypted: false,
          timestamp: Date.now(),
          sha256,
        },
        payload: sourcePayload,
      },
      );

      // The fountain encoder is intentionally v1 single-segment. Enforce the
      // exact serialized container capacity before allocating a session so the
      // user receives an actionable selection error instead of a late encoder
      // block-count failure.
      if (payload.length > V1_MAX_SERIALIZED_CONTAINER_BYTES) {
        throw new DeqrError(
          ErrorCode.FILE_TOO_LARGE,
          'File plus DEQR metadata exceeds the v1 optical transfer capacity. Select a smaller file.',
        );
      }

      const sessionId = this.nextSessionId++;
      this.sessions.set(sessionId, {
        id: sessionId,
        filepath,
        metadata,
        payload
      });
      payload = undefined;

      return { sessionId, metadata };
    } finally {
      sourcePayload.fill(0);
      payload?.fill(0);
    }
  }

  public getSession(sessionId: number): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new DeqrError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or expired');
    }
    return session;
  }

  /** Returns an active session when present without treating an already-cancelled
   * session as an error. This is appropriate for idempotent UI cancellation. */
  public findSession(sessionId: number): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  public removeSession(sessionId: number) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.stopTransfer(session);
      session.encoder = undefined;
      session.payload.fill(0);
      this.sessions.delete(sessionId);
    }
  }

  public stopTransfer(session: SessionState) {
    if (session.activeTransfer) {
      if (session.activeTransfer.intervalId !== null) {
        clearInterval(session.activeTransfer.intervalId);
      }
      session.activeTransfer = undefined;
    }
    if (session.activeLoopback) {
      clearInterval(session.activeLoopback.intervalId);
      session.activeLoopback = undefined;
    }
  }
}

export const globalSessionManager = new SessionManager();
