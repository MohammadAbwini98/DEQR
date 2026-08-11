import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FILE_SIZE,
  PROTOCOL_VERSION,
  serializeContainer,
} from '../../src/core/container';
import { computeSha256 } from '../../src/core/hash';

type IpcHandler = (event: { sender: object }, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: mocks.fromWebContents,
  },
  dialog: {
    showSaveDialog: mocks.showSaveDialog,
  },
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      writeFile: mocks.writeFile,
      rename: mocks.rename,
      unlink: mocks.unlink,
    },
  },
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';

const event = { sender: {} };
const windowStub = { id: 1 };
const destination = 'C:\\received\\payload.bin';

function validContainer(
  filename = 'payload.bin',
  payload = Buffer.from('verified payload'),
  sha256 = computeSha256(payload),
): Buffer {
  return serializeContainer({
    metadata: {
      protocolVersion: PROTOCOL_VERSION,
      filename,
      mimeType: 'application/octet-stream',
      originalSize: payload.length,
      compressed: false,
      encrypted: false,
      timestamp: 1_700_000_000_000,
      sha256,
    },
    payload,
  });
}

function originalSizeOffset(container: Buffer): number {
  let offset = 4 + 2;
  const filenameLength = container.readUInt16BE(offset);
  offset += 2 + filenameLength;
  const mimeLength = container.readUInt16BE(offset);
  return offset + 2 + mimeLength;
}

function receiveHandler(): IpcHandler {
  const handler = mocks.handlers.get('receive:saveReceivedFile');
  if (!handler) throw new Error('receive:saveReceivedFile was not registered');
  return handler;
}

describe('receive:saveReceivedFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.fromWebContents.mockReturnValue(windowStub);
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rename.mockResolvedValue(undefined);
    mocks.unlink.mockResolvedValue(undefined);
    registerIpcHandlers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false before parsing when the sender has no BrowserWindow', async () => {
    mocks.fromWebContents.mockReturnValue(undefined);

    await expect(receiveHandler()(event, validContainer(), 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['plain object', { unexpected: true }],
  ])('rejects malformed %s input without prompting or writing', async (_label, input) => {
    await expect(receiveHandler()(event, input, 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a valid container represented as a plain number array', async () => {
    const container = validContainer();
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });

    await expect(
      receiveHandler()(event, Array.from(container), 'fallback.bin'),
    ).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a truncated Uint8Array before prompting or writing', async () => {
    const truncated = Uint8Array.from(Buffer.from('DEQR'));

    await expect(receiveHandler()(event, truncated, 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a container whose declared size exceeds the production limit', async () => {
    const container = validContainer();
    container.writeBigUInt64BE(BigInt(MAX_FILE_SIZE + 1), originalSizeOffset(container));

    await expect(receiveHandler()(event, container, 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a SHA-256 mismatch before prompting or writing', async () => {
    const container = validContainer(
      'payload.bin',
      Buffer.from('payload'),
      Buffer.alloc(32, 0xa5),
    );

    await expect(receiveHandler()(event, container, 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a blocked extension before prompting or writing', async () => {
    const container = validContainer('payload.CMD');

    await expect(receiveHandler()(event, container, 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('returns false without writing when the save dialog is cancelled', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });

    await expect(receiveHandler()(event, validContainer(), 'fallback.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(
      windowStub,
      expect.objectContaining({ defaultPath: 'payload.bin' }),
    );
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('attempts temp cleanup when writing the temp file fails', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    mocks.writeFile.mockRejectedValueOnce(new Error('write failed'));

    await expect(receiveHandler()(event, validContainer(), 'fallback.bin')).resolves.toBe(false);
    const temporaryPath = mocks.writeFile.mock.calls[0][0] as string;
    expect(temporaryPath).toMatch(/^C:\\received\\payload\.bin\..+\.deqr\.tmp$/);
    expect(mocks.unlink).toHaveBeenCalledWith(temporaryPath);
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it('removes the temp file when the atomic rename fails', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });
    mocks.rename.mockRejectedValueOnce(new Error('rename failed'));

    await expect(receiveHandler()(event, validContainer(), 'fallback.bin')).resolves.toBe(false);
    const temporaryPath = mocks.writeFile.mock.calls[0][0] as string;
    expect(mocks.rename).toHaveBeenCalledWith(temporaryPath, destination);
    expect(mocks.unlink).toHaveBeenCalledWith(temporaryPath);
  });

  it('writes to a unique temp path before atomically renaming on success', async () => {
    const payload = Buffer.from('verified payload');
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination });

    await expect(
      receiveHandler()(event, validContainer('payload.bin', payload), 'fallback.bin'),
    ).resolves.toBe(true);

    const temporaryPath = mocks.writeFile.mock.calls[0][0] as string;
    expect(temporaryPath).toMatch(/^C:\\received\\payload\.bin\..+\.deqr\.tmp$/);
    expect(mocks.writeFile).toHaveBeenCalledWith(temporaryPath, payload);
    expect(mocks.rename).toHaveBeenCalledWith(temporaryPath, destination);
    expect(mocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rename.mock.invocationCallOrder[0],
    );
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
