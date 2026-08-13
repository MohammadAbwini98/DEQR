import { describe, expect, it, vi } from 'vitest';

/**
 * Guards the preload/main invoke contract.
 *
 * `loopback:saveVerifiedResult` shipped for months as a preload method with no
 * main-process handler, because nothing compared the two sides: the preload
 * suite proved the bridge routed to a channel, and the main suite proved the
 * handlers it knew about worked. Neither could see the gap between them.
 *
 * Both sides here are derived from production code rather than a maintained
 * list — the preload channels by executing the real bridge, the handler
 * channels by executing the real registration. A hand-copied inventory would
 * reproduce the DESKTOP-SEC-050 failure, where a duplicated policy in a test
 * silently diverged from the implementation it claimed to cover.
 */

type IpcHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  invoked: new Set<string>(),
  subscribed: new Set<string>(),
  exposed: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, api: unknown) => mocks.exposed.set(key, api)),
  },
  ipcRenderer: {
    invoke: vi.fn((channel: string) => {
      mocks.invoked.add(channel);
      return Promise.resolve();
    }),
    on: vi.fn((channel: string) => mocks.subscribed.add(channel)),
    removeListener: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => 'C:\\deqr-test-userdata') },
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';
import '../../src/preload/index';

/** Walks the exposed bridge and calls every leaf so it reveals its channel. */
function collectPreloadChannels(): { invoked: Set<string>; subscribed: Set<string> } {
  const api = mocks.exposed.get('deqr');
  expect(api, 'preload must expose the deqr bridge').toBeDefined();

  const visit = (value: unknown): void => {
    if (typeof value === 'function') {
      // Arguments are placeholders: every transport is mocked, so a call only
      // has to reach `invoke`/`on` to disclose the channel it targets.
      (value as (...args: unknown[]) => unknown)(1, () => undefined);
      return;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) visit(nested);
    }
  };

  visit(api);
  return { invoked: mocks.invoked, subscribed: mocks.subscribed };
}

describe('preload/main IPC contract', () => {
  it('registers a main handler for every channel the preload bridge invokes', () => {
    registerIpcHandlers();
    const { invoked } = collectPreloadChannels();

    expect(invoked.size, 'the bridge should expose invoke channels').toBeGreaterThan(0);

    const orphaned = [...invoked].filter((channel) => !mocks.handlers.has(channel)).sort();
    expect(orphaned, 'preload invokes channels that no main handler answers').toEqual([]);
  });

  it('no longer exposes the loopback save channel that never had a handler', () => {
    const { invoked } = collectPreloadChannels();
    const api = mocks.exposed.get('deqr') as { loopback: Record<string, unknown> };

    // Loopback re-decodes a file already on local disk and releases the session
    // as soon as it completes, so there is never a verified artifact to persist.
    expect(invoked.has('loopback:saveVerifiedResult')).toBe(false);
    expect(mocks.handlers.has('loopback:saveVerifiedResult')).toBe(false);
    expect(api.loopback.saveVerifiedResult).toBeUndefined();
    expect(Object.keys(api.loopback).sort()).toEqual(['cancel', 'start', 'subscribe']);
  });

  it('keeps the receive save path, which is where external bytes are persisted', () => {
    registerIpcHandlers();
    const { invoked } = collectPreloadChannels();

    expect(invoked.has('receive:saveReceivedFile')).toBe(true);
    expect(mocks.handlers.has('receive:saveReceivedFile')).toBe(true);
  });

  it('treats main-to-renderer push channels as subscriptions, not invoke contracts', () => {
    const { subscribed, invoked } = collectPreloadChannels();

    // These are `webContents.send` targets. Requiring `ipcMain.handle` for them
    // would make the contract test wrong rather than strict.
    expect([...subscribed].some((channel) => channel.startsWith('transfer:frame:'))).toBe(true);
    expect(subscribed.has('pwaHost:status')).toBe(true);
    for (const channel of subscribed) expect(invoked.has(channel)).toBe(false);
  });
});
