import { dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { computeSha256 } from '../core/hash';
import { sanitizeFilename, isBlockedExtension } from '../core/filename-sanitizer';
import { ErrorCode, DeqrError } from '../shared/errors';
import { SafeDisplayMetadata } from '../shared/types';
import { FountainEncoder } from '../core/fountain-encoder';
import { PROTOCOL_VERSION, serializeContainer } from '../core/container';

export interface SessionState {
  id: number;
  filepath: string;
  metadata: SafeDisplayMetadata;
  payload: Buffer;
  encoder?: FountainEncoder;
  activeTransfer?: {
    intervalId: NodeJS.Timeout;
    framesGenerated: number;
    startTime: number;
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
  private readonly MAX_FILE_SIZE = 64 * 1024 * 1024; // 64MB phase 1

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

    if (stat.size > this.MAX_FILE_SIZE) {
      throw new DeqrError(ErrorCode.FILE_TOO_LARGE, `File exceeds maximum allowed size of 64MB`);
    }

    const parsedPath = path.parse(filepath);
    const sanitizedName = sanitizeFilename(parsedPath.base);
    
    if (isBlockedExtension(sanitizedName)) {
      throw new DeqrError(ErrorCode.FILE_TYPE_BLOCKED, 'File extension is blocked by security policy');
    }

    // The fountain stream transports a complete DEQR container, never the raw
    // source file. Receivers need this metadata to validate and safely save it.
    const sourcePayload = fs.readFileSync(filepath);
    const sha256 = computeSha256(sourcePayload);
    
    // In a real implementation, we would try to compress here and check if it's beneficial.
    // For M1, we skip compression to keep the flow simple, but report it.
    
    const sessionId = this.nextSessionId++;
    const metadata: SafeDisplayMetadata = {
      filename: sanitizedName,
      extension: parsedPath.ext.replace('.', ''),
      size: stat.size,
      mimeType: 'application/octet-stream', // Generic fallback
      sha256: sha256.toString('hex'),
      compressed: false
    };

    const payload = serializeContainer({
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
    });

    this.sessions.set(sessionId, {
      id: sessionId,
      filepath,
      metadata,
      payload
    });

    return { sessionId, metadata };
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
      this.sessions.delete(sessionId);
    }
  }

  public stopTransfer(session: SessionState) {
    if (session.activeTransfer) {
      clearInterval(session.activeTransfer.intervalId);
      session.activeTransfer = undefined;
    }
    if (session.activeLoopback) {
      clearInterval(session.activeLoopback.intervalId);
      session.activeLoopback = undefined;
    }
  }
}

export const globalSessionManager = new SessionManager();
