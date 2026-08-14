import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Shutdown and cancellation safety for the animated-transfer timers.
 *
 * A packaged build raised `TypeError: Object has been destroyed` from
 * `generateFrame` when the window was closed mid-transfer: the interval is a
 * Node timer with no relationship to the window, so it kept firing after
 * Electron had torn down the renderer, and `webContents.send` threw inside a
 * timer callback where nothing could catch it.
 *
 * These drive the real `registerIpcHandlers` and the real `SessionManager`
 * against a WebContents double that behaves like Electron's: once destroyed,
 * `send` throws exactly as the native binding does.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  windows: [] as unknown[],
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn((c: string, h: IpcHandler) => mocks.handlers.set(c, h)) },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ id: 1 })),
    getAllWindows: vi.fn(() => mocks.windows),
  },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';
import { globalSessionManager } from '../../src/main/session-manager';

/** Mirrors Electron: a destroyed WebContents throws on `send`. */
class FakeWebContents {
  destroyed = false;
  readonly sent: Array<{ channel: string; args: unknown[] }> = [];

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) {
      throw new TypeError('Object has been destroyed');
    }
    this.sent.push({ channel, args });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const TRUSTED_FRAME = { url: 'file:///C:/deqr/dist/renderer/index.html', parent: null };
const eventFor = (sender: FakeWebContents) => ({ sender, senderFrame: TRUSTED_FRAME });

let fixture: string;

async function newSession(sender: FakeWebContents): Promise<number> {
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [fixture] });
  const result = (await mocks.handlers.get('files:selectForTransfer')!(eventFor(sender))) as {
    sessionId: number;
  };
  return result.sessionId;
}

const call = (channel: string, sender: FakeWebContents, ...args: unknown[]) =>
  mocks.handlers.get(channel)!(eventFor(sender), ...args);

describe('animated transfer lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.handlers.clear();
    (globalSessionManager as unknown as { sessions: Map<number, unknown> }).sessions.clear();
    registerIpcHandlers();
    fixture = path.join(os.tmpdir(), `deqr-lifecycle-${process.pid}.bin`);
    // Large enough that the encoder keeps producing frames for the whole test.
    fs.writeFileSync(fixture, Buffer.alloc(64 * 1024, 7));
  });

  afterEach(() => {
    vi.useRealTimers();
    try { fs.unlinkSync(fixture); } catch { /* best effort */ }
  });

  it('stops sending frames once the renderer is destroyed, without throwing', async () => {
    const sender = new FakeWebContents();
    const sessionId = await newSession(sender);
    await call('transfer:start', sender, sessionId);

    vi.advanceTimersByTime(500);
    const delivered = sender.sent.length;
    expect(delivered, 'frames should flow while the renderer is alive').toBeGreaterThan(0);

    // Closing the window destroys the renderer while the interval is pending.
    sender.destroy();

    // The original defect surfaced here as an uncaught TypeError inside a timer.
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(sender.sent.length, 'nothing may be delivered after destruction').toBe(delivered);
  });

  it('cancels the timer instead of spinning against a dead renderer', async () => {
    const sender = new FakeWebContents();
    const sessionId = await newSession(sender);
    await call('transfer:start', sender, sessionId);

    vi.advanceTimersByTime(300);
    sender.destroy();
    vi.advanceTimersByTime(300);

    // A live timer would keep encoding frames forever for a window that is gone.
    expect(vi.getTimerCount(), 'the transfer timer must be cleared').toBe(0);
    expect(globalSessionManager.findSession(sessionId)?.activeTransfer).toBeUndefined();
  });

  it('keeps a cancelled transfer from emitting another frame', async () => {
    const sender = new FakeWebContents();
    const sessionId = await newSession(sender);
    await call('transfer:start', sender, sessionId);
    vi.advanceTimersByTime(300);

    const beforeCancel = sender.sent.length;
    await call('transfer:cancel', sender, sessionId);
    vi.advanceTimersByTime(2_000);

    expect(sender.sent.length).toBe(beforeCancel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a replaced session run while the cancelled one stays silent', async () => {
    const sender = new FakeWebContents();
    const first = await newSession(sender);
    await call('transfer:start', sender, first);
    vi.advanceTimersByTime(300);
    await call('transfer:cancel', sender, first);

    const second = await newSession(sender);
    await call('transfer:start', sender, second);
    sender.sent.length = 0;
    vi.advanceTimersByTime(500);

    const channels = new Set(sender.sent.map((entry) => entry.channel));
    expect(channels.has(`transfer:frame:${second}`)).toBe(true);
    expect(channels.has(`transfer:frame:${first}`), 'the cancelled session must stay silent').toBe(false);
  });

  it('applies the same protection to the loopback timer', async () => {
    const sender = new FakeWebContents();
    const sessionId = await newSession(sender);
    await call('loopback:start', sender, sessionId, { lossPercentage: 0 });

    vi.advanceTimersByTime(200);
    expect(sender.sent.length).toBeGreaterThan(0);
    const delivered = sender.sent.length;

    sender.destroy();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    expect(sender.sent.length).toBe(delivered);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases every session and timer when the application shuts down', async () => {
    const senderA = new FakeWebContents();
    const senderB = new FakeWebContents();
    const a = await newSession(senderA);
    const b = await newSession(senderB);
    await call('transfer:start', senderA, a);
    await call('transfer:start', senderB, b);
    vi.advanceTimersByTime(300);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    globalSessionManager.disposeAll();

    expect(vi.getTimerCount(), 'no timer may outlive shutdown').toBe(0);
    expect(globalSessionManager.findSession(a)).toBeUndefined();
    expect(globalSessionManager.findSession(b)).toBeUndefined();

    senderA.destroy();
    senderB.destroy();
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
  });
});
