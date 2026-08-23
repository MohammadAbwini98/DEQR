import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: { sender: object }, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: mocks.fromWebContents,
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showSaveDialog: mocks.showSaveDialog,
    showOpenDialog: mocks.showOpenDialog,
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

import { readLossPercentage, registerIpcHandlers } from '../../src/main/ipc-handlers';
import { globalSessionManager } from '../../src/main/session-manager';

/**
 * What the renderer is allowed to say, and what happens when it says something else.
 *
 * Every channel here is reachable from a trusted renderer frame, and "trusted"
 * means the frame this build loaded - not that its arguments are correct. A
 * renderer is a browser process running our own code; a defect in it, or a
 * successful injection into it, produces a caller that sends whatever it likes
 * over an already-authorised channel. So the boundary validates types, not
 * origins alone.
 *
 * The case that made this file necessary is `loopback:start`. Its options
 * object was read as `any` from inside a `setInterval` callback, so a `null`
 * threw in a timer - and a throw in a timer callback reaches no caller. It
 * surfaces as Electron's "A JavaScript error occurred in the main process"
 * dialog, which is a renderer-triggered crash of the privileged process.
 */

// A trusted packaged renderer: top-level frame at a local file URL.
const event = {
  sender: {},
  senderFrame: { url: 'file:///C:/deqr/dist/renderer/index.html', parent: null },
};

/** Values a renderer can put on the wire that are not a session id. */
const NOT_A_SESSION_ID: unknown[] = [
  undefined,
  null,
  'ok',
  -1,
  0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  { toString: () => '1' },
  [1],
];

beforeEach(() => {
  mocks.handlers.clear();
  vi.useFakeTimers();
  registerIpcHandlers();
});

afterEach(() => {
  globalSessionManager.disposeAll();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel);
  expect(handler, `no handler for ${channel}`).toBeDefined();
  return handler!(event, ...args);
}

describe('readLossPercentage', () => {
  it('reads a number out of a well-formed options object', () => {
    expect(readLossPercentage({ lossPercentage: 25 })).toBe(25);
    expect(readLossPercentage({ lossPercentage: 0 })).toBe(0);
  });

  it('answers zero for every shape that is not one', () => {
    for (const value of [undefined, null, 0, 'ten', [], { lossPercentage: '10' }, { lossPercentage: {} }, { lossPercentage: Number.NaN }]) {
      expect(readLossPercentage(value), `${JSON.stringify(value) ?? String(value)}`).toBe(0);
    }
  });

  it('clamps rather than trusting a number outside the range', () => {
    // A percentage is a percentage. Nothing downstream should have to defend
    // against `Math.random() < -50`, which silently disables the simulation, or
    // against a value that makes it drop everything forever.
    expect(readLossPercentage({ lossPercentage: 1_000 })).toBe(100);
    expect(readLossPercentage({ lossPercentage: -5 })).toBe(0);
  });
});

describe('session-taking channels refuse a value that is not a session id', () => {
  it('never throws out of a timer for loopback:start', async () => {
    for (const sessionId of NOT_A_SESSION_ID) {
      const result = await invoke('loopback:start', sessionId, null);
      // A sanitized error, never an exception and never a live interval.
      expect(result).toMatchObject({ error: expect.anything() });
    }
    // No timer was ever armed, so advancing the clock cannot reach a callback
    // holding a renderer-supplied object.
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
  });

  it('returns a sanitized error rather than throwing for transfer:start', async () => {
    for (const sessionId of NOT_A_SESSION_ID) {
      const result = await invoke('transfer:start', sessionId);
      expect(result).toMatchObject({ error: expect.anything() });
    }
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
  });

  it('is a silent no-op where cancellation is already idempotent', async () => {
    for (const sessionId of NOT_A_SESSION_ID) {
      await expect(invoke('transfer:cancel', sessionId)).resolves.toBeUndefined();
      await expect(invoke('loopback:cancel', sessionId)).resolves.toBeUndefined();
      await expect(invoke('files:discardSelection', sessionId)).resolves.toBeUndefined();
      await expect(invoke('transfer:pause', sessionId)).resolves.toBeUndefined();
      await expect(invoke('transfer:resume', sessionId)).resolves.toBeUndefined();
      await expect(invoke('streamTransfer:cancel', sessionId)).resolves.toBeUndefined();
    }
  });

  it('answers null rather than an exception for streaming progress', async () => {
    for (const sessionId of NOT_A_SESSION_ID) {
      await expect(invoke('streamTransfer:progress', sessionId)).resolves.toBeNull();
    }
  });

  it('answers a sanitized error for a streaming frame request', async () => {
    for (const sessionId of NOT_A_SESSION_ID) {
      const result = await invoke('streamTransfer:nextFrame', sessionId);
      expect(result).toMatchObject({ error: expect.anything() });
    }
  });
});

describe('streamTransfer:select bounds what it forwards', () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReturnValue({ id: 1 });
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  });

  it('accepts a request object without a resume token', async () => {
    await expect(invoke('streamTransfer:select')).resolves.toBeNull();
    await expect(invoke('streamTransfer:select', null)).resolves.toBeNull();
    await expect(invoke('streamTransfer:select', 'not an object')).resolves.toBeNull();
    expect(mocks.showOpenDialog).toHaveBeenCalled();
  });

  it('drops an over-long resume code before it reaches the token parser', async () => {
    // The codec refuses a malformed token on its own; this is the bound in
    // front of it, so a megabyte of text is never handed to a parser at all.
    await invoke('streamTransfer:select', { resumeToken: 'A'.repeat(1_000_000) });
    const [, options] = mocks.showOpenDialog.mock.calls.at(-1)!;
    // A dropped token means the ordinary "select a file" dialog rather than the
    // resume one, which is how the refusal is visible without a return value.
    expect(options.title).toBe('Select File to Transfer');
  });

  it('keeps a plausible resume code', async () => {
    await invoke('streamTransfer:select', { resumeToken: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH' });
    const [, options] = mocks.showOpenDialog.mock.calls.at(-1)!;
    expect(options.title).toBe('Select the File to Resume');
  });

  it('ignores a transport profile id that is not a number', async () => {
    // `resolveTransportProfile` falls back rather than failing, and the point
    // here is only that a non-number cannot reach it as one.
    await expect(invoke('streamTransfer:select', { transportProfileId: '4' })).resolves.toBeNull();
    await expect(invoke('streamTransfer:select', { transportProfileId: {} })).resolves.toBeNull();
  });
});

describe('receive:saveReceivedFile refuses before it writes', () => {
  beforeEach(() => {
    mocks.fromWebContents.mockReturnValue({ id: 1 });
  });

  it('refuses a container that is not bytes', async () => {
    for (const payload of [undefined, null, 'bytes', 42, {}, [1, 2, 3]]) {
      await expect(invoke('receive:saveReceivedFile', payload, 'out.bin')).resolves.toBe(false);
    }
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('refuses a container above the v1 transport capacity without parsing it', async () => {
    const oversized = new Uint8Array(512 * 65_535 + 1);
    await expect(invoke('receive:saveReceivedFile', oversized, 'out.bin')).resolves.toBe(false);
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });
});
