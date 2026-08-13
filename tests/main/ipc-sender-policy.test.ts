import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';

/**
 * Exercises the shipped sender policy directly. Nothing here restates the
 * origin rules: DESKTOP-SEC-050 was caused by a test carrying its own copy of a
 * security policy that drifted from the implementation it claimed to cover, so
 * these import the production predicates and the production registration.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  isPackaged: { value: true },
}));

vi.mock('electron', () => ({
  get app() {
    return { isPackaged: mocks.isPackaged.value };
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  dialog: { showSaveDialog: vi.fn() },
}));

import { isTrustedIpcSender, isTrustedIpcSenderUrl } from '../../src/main/ipc-sender-policy';
import { registerIpcHandlers } from '../../src/main/ipc-handlers';

const PACKAGED_RENDERER = 'file:///C:/Program%20Files/deqr/resources/app.asar/dist/renderer/index.html';
const DEV_RENDERER = 'http://localhost:5173/';

const topLevel = (url: string | null | undefined) => ({ senderFrame: { url, parent: null } });

describe('trusted IPC sender URLs', () => {
  it('accepts the packaged renderer document in both build modes', () => {
    expect(isTrustedIpcSenderUrl(PACKAGED_RENDERER, true)).toBe(true);
    expect(isTrustedIpcSenderUrl(PACKAGED_RENDERER, false)).toBe(true);
  });

  it('accepts the development server only when the build is not packaged', () => {
    expect(isTrustedIpcSenderUrl(DEV_RENDERER, false)).toBe(true);
    expect(isTrustedIpcSenderUrl('http://127.0.0.1:5173/', false)).toBe(true);

    // A shipped app must never treat a development server as its own renderer,
    // whatever happens to be listening on that port.
    expect(isTrustedIpcSenderUrl(DEV_RENDERER, true)).toBe(false);
    expect(isTrustedIpcSenderUrl('http://127.0.0.1:5173/', true)).toBe(false);
  });

  it('rejects every neighbouring origin that is not the development server', () => {
    for (const url of [
      'http://localhost:5174/',           // the PWA host: a separate trust domain
      'https://localhost:5173/',          // wrong scheme
      'http://localhost:5175/',           // wrong port
      'http://evil.test:5173/',           // wrong host
      'http://user:pass@localhost:5173/', // credentials
      'http://localhost.evil.test:5173/', // suffix confusion
    ]) {
      expect(isTrustedIpcSenderUrl(url, false), url).toBe(false);
    }
  });

  it('rejects opaque and tooling origins that may load but may never call', () => {
    // `isAllowedRendererRequest` permits these as resources. Trusting a
    // `data:` document as a caller would hand the bridge to an opaque origin.
    expect(isTrustedIpcSenderUrl('data:text/html,<script>1</script>', true)).toBe(false);
    expect(isTrustedIpcSenderUrl('devtools://devtools/bundled/inspector.html', true)).toBe(false);
    expect(isTrustedIpcSenderUrl('file://remote-host/share/index.html', true)).toBe(false);
  });

  it('rejects malformed, empty, and non-string values', () => {
    for (const value of ['', 'not a url', '://', null, undefined, 42 as unknown as string]) {
      expect(isTrustedIpcSenderUrl(value as string, true), String(value)).toBe(false);
    }
  });
});

describe('trusted IPC sender frames', () => {
  it('accepts a trusted top-level frame', () => {
    expect(isTrustedIpcSender(topLevel(PACKAGED_RENDERER), true)).toBe(true);
  });

  it('rejects a subframe even when its URL is trusted', () => {
    const subframe = { senderFrame: { url: PACKAGED_RENDERER, parent: { url: PACKAGED_RENDERER } } };
    expect(isTrustedIpcSender(subframe, true)).toBe(false);
  });

  it('rejects a destroyed, absent, or unreadable sender frame', () => {
    expect(isTrustedIpcSender({ senderFrame: null }, true)).toBe(false);
    expect(isTrustedIpcSender({}, true)).toBe(false);
    expect(isTrustedIpcSender(undefined as never, true)).toBe(false);
    expect(isTrustedIpcSender({ get senderFrame(): never { throw new Error('gone'); } }, true)).toBe(false);
  });

  it('rejects a frame whose parent is not reported, rather than assuming top level', () => {
    expect(isTrustedIpcSender({ senderFrame: { url: PACKAGED_RENDERER } }, true)).toBe(false);
  });
});

describe('registered handlers enforce the policy', () => {
  const registered = (): Map<string, IpcHandler> => {
    mocks.handlers.clear();
    registerIpcHandlers();
    expect(mocks.handlers.size).toBeGreaterThan(0);
    return mocks.handlers;
  };

  it('rejects an untrusted sender on every registered channel', () => {
    mocks.isPackaged.value = true;
    const handlers = registered();
    const hostile = topLevel('http://evil.test/');

    // Enumerated from production registration: a channel added later without
    // the guard fails here without anyone remembering to list it.
    for (const [channel, handler] of handlers) {
      let thrown: unknown;
      try {
        handler(hostile);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${channel} accepted an untrusted sender`).toBeInstanceOf(Error);
      expect((thrown as { code?: string }).code, channel).toBe(ErrorCode.IPC_SENDER_REJECTED);
      // Sanitized: no origin, no path, no internals.
      expect((thrown as Error).message, channel).toBe('IPC request rejected.');
    }
  });

  it('does not reach the privileged operation after rejection', async () => {
    mocks.isPackaged.value = true;
    const handlers = registered();
    const { pwaHostLifecycle } = await import('../../src/main/pwa-host-lifecycle');
    const start = vi.spyOn(pwaHostLifecycle, 'start');

    expect(() => handlers.get('pwaHost:start')!(topLevel('http://evil.test/'))).toThrow();

    // The listener and its key material are the point of the guard.
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('rejects a subframe of the real renderer on the most privileged channel', () => {
    mocks.isPackaged.value = true;
    const handlers = registered();
    const subframe = { senderFrame: { url: PACKAGED_RENDERER, parent: { url: PACKAGED_RENDERER } } };

    expect(() => handlers.get('pwaHost:start')!(subframe)).toThrow();
  });

  it('lets the legitimate packaged renderer through', () => {
    mocks.isPackaged.value = true;
    const handlers = registered();

    // getStatus is side-effect free, so reaching it proves the guard passed.
    expect(() => handlers.get('pwaHost:getStatus')!(topLevel(PACKAGED_RENDERER))).not.toThrow();
  });

  it('lets the legitimate development renderer through only when unpackaged', () => {
    mocks.isPackaged.value = false;
    const handlers = registered();
    expect(() => handlers.get('pwaHost:getStatus')!(topLevel(DEV_RENDERER))).not.toThrow();

    mocks.isPackaged.value = true;
    expect(() => handlers.get('pwaHost:getStatus')!(topLevel(DEV_RENDERER))).toThrow();
  });

  it('covers window controls rather than exempting them', () => {
    mocks.isPackaged.value = true;
    const handlers = registered();

    // Deliberate: a frame that may not open a listener may not close the
    // window mid-transfer either.
    for (const channel of ['windowControls:minimize', 'windowControls:maximizeOrRestore', 'windowControls:close']) {
      expect(() => handlers.get(channel)!(topLevel('http://evil.test/')), channel).toThrow();
    }
  });
});
