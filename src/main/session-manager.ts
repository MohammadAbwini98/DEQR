import { dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { computeSha256 } from '../core/hash';
import { sanitizeFilename, isBlockedExtension } from '../core/filename-sanitizer';
import { ErrorCode, DeqrError } from '../shared/errors';
import { SafeDisplayMetadata } from '../shared/types';
import { FountainEncoder } from '../core/fountain-encoder';

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

    // Read full payload to compute SHA and prepare for core
    const payload = fs.readFileSync(filepath);
    const sha256 = computeSha256(payload);
    
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
