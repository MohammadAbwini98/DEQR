import { describe, it, expect, vi, beforeEach } from 'vitest';
import { globalSessionManager } from '../../src/main/session-manager';
import { ErrorCode } from '../../src/shared/errors';
import * as fs from 'fs';
import * as path from 'path';
import { dialog } from 'electron';
import { deserializeContainer } from '../../src/core/container';

// Mock electron
vi.mock('electron', () => {
  return {
    dialog: {
      showOpenDialog: vi.fn()
    },
    BrowserWindow: vi.fn(),
    ipcMain: {
      handle: vi.fn()
    }
  };
});

describe('Main Process: Session Manager', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear sessions
    (globalSessionManager as any).sessions.clear();
  });

  it('selects file and creates session successfully', async () => {
    // Setup a dummy file
    const dummyPath = path.join(__dirname, 'dummy.txt');
    fs.writeFileSync(dummyPath, 'hello world');

    (dialog.showOpenDialog as any).mockResolvedValue({
      canceled: false,
      filePaths: [dummyPath]
    });

    const window = {} as any;
    const result = await globalSessionManager.selectFile(window);
    
    expect(result).not.toBeNull();
    expect(result!.metadata.filename).toBe('dummy.txt');
    expect(result!.metadata.size).toBe(11);
    
    const session = globalSessionManager.getSession(result!.sessionId);
    expect(session.filepath).toBe(dummyPath);
    const container = deserializeContainer(session.payload);
    expect(container.metadata.filename).toBe('dummy.txt');
    expect(container.metadata.originalSize).toBe(11);
    expect(container.payload.toString('utf8')).toBe('hello world');
    expect(container.metadata.sha256.toString('hex')).toBe(result!.metadata.sha256);
    
    fs.unlinkSync(dummyPath);
  });

  it('handles cancellation gracefully', async () => {
    (dialog.showOpenDialog as any).mockResolvedValue({
      canceled: true,
      filePaths: []
    });

    const window = {} as any;
    const result = await globalSessionManager.selectFile(window);
    expect(result).toBeNull();
  });

  it('throws when getting non-existent session', () => {
    expect(() => globalSessionManager.getSession(999)).toThrow(/Session not found/);
  });

  it('returns undefined when finding a non-existent session for idempotent cancellation', () => {
    expect(globalSessionManager.findSession(999)).toBeUndefined();
  });
});
