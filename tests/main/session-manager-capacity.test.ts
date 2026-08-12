import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    statSync: fsMocks.statSync,
    readFileSync: fsMocks.readFileSync,
  };
});

import { dialog } from 'electron';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { ErrorCode } from '../../src/shared/errors';
import {
  SessionManager,
  V1_MAX_SERIALIZED_CONTAINER_BYTES,
} from '../../src/main/session-manager';

const FIXTURE_PATH = 'C:\\qa-fixtures\\capacity-boundary.bin';
const FIXTURE_NAME = 'capacity-boundary.bin';
const MIME_TYPE = 'application/octet-stream';

function serializedHeaderBytes(): number {
  return serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename: FIXTURE_NAME,
      mimeType: MIME_TYPE,
      originalSize: 0,
      compressed: false,
      encrypted: false,
      timestamp: 0,
      sha256: Buffer.alloc(32),
    },
    payload: Buffer.alloc(0),
  }).length;
}

function selectMockFixture(size: number): void {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: [FIXTURE_PATH],
  } as never);
  fsMocks.statSync.mockReturnValue({
    size,
    isFile: () => true,
  } as fs.Stats);
}

describe('SessionManager v1 serialized-capacity preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['at', V1_MAX_SERIALIZED_CONTAINER_BYTES],
    ['one byte above', V1_MAX_SERIALIZED_CONTAINER_BYTES + 1],
  ])('rejects a raw source %s the v1 transport ceiling before reading it', async (_case, size) => {
    selectMockFixture(size);
    const manager = new SessionManager();

    await expect(manager.selectFile({} as never)).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });

    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(manager.findSession(1)).toBeUndefined();
  });

  it('accepts a synthetic source whose actual serialized container is exactly the v1 capacity', async () => {
    const source = Buffer.alloc(
      V1_MAX_SERIALIZED_CONTAINER_BYTES - serializedHeaderBytes(),
      0xa5,
    );
    selectMockFixture(source.length);
    fsMocks.readFileSync.mockReturnValue(source);
    const manager = new SessionManager();

    const selection = await manager.selectFile({} as never);

    expect(selection).not.toBeNull();
    const session = manager.getSession(selection!.sessionId);
    expect(session.payload).toHaveLength(V1_MAX_SERIALIZED_CONTAINER_BYTES);
    expect(source.every((byte) => byte === 0)).toBe(true);

    manager.removeSession(selection!.sessionId);
    expect(session.payload.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects one serialized byte over capacity and clears the synthetic read buffer', async () => {
    const source = Buffer.alloc(
      V1_MAX_SERIALIZED_CONTAINER_BYTES - serializedHeaderBytes() + 1,
      0x5a,
    );
    selectMockFixture(source.length);
    fsMocks.readFileSync.mockReturnValue(source);
    const manager = new SessionManager();

    await expect(manager.selectFile({} as never)).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });

    expect(fsMocks.readFileSync).toHaveBeenCalledOnce();
    expect(source.every((byte) => byte === 0)).toBe(true);
    expect(manager.findSession(1)).toBeUndefined();
  });
});
