import { describe, expect, it, vi } from 'vitest';
import {
  HOST_HEALTH_SERVICE,
  HOST_HEALTH_URL,
  HostMonitor,
  hostStatusCopy,
  probeHost,
  type HostStatus,
} from '../src/host-status';

function healthResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/** Drives the monitor's timers by hand so no test waits on a real interval. */
function controlledMonitor(responses: Array<() => Promise<Response>>) {
  const changes: HostStatus[] = [];
  const timers: Array<{ handle: number; handler: () => void; ms: number }> = [];
  let nextHandle = 1;
  let call = 0;

  const monitor = new HostMonitor({
    fetch: (async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return next();
    }) as unknown as typeof globalThis.fetch,
    onChange: (status) => changes.push(status),
    setTimeout: (handler, ms) => {
      const handle = nextHandle++;
      timers.push({ handle, handler, ms });
      return handle;
    },
    clearTimeout: (handle) => {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  return {
    monitor,
    changes,
    calls: () => call,
    pending: () => timers.length,
    lastDelay: () => timers[timers.length - 1]?.ms,
    fire: () => {
      const timer = timers.shift();
      timer?.handler();
    },
  };
}

describe('desktop host reachability probe', () => {
  it('requests the health path without caching and accepts only the host marker', async () => {
    const fetchMock = vi.fn(async () => healthResponse({ service: HOST_HEALTH_SERVICE, status: 'ok' }));

    await expect(probeHost({ fetch: fetchMock as unknown as typeof globalThis.fetch })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HOST_HEALTH_URL);
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a 200 that is not the receiver host', async () => {
    // The single-page fallback and a captive portal both answer 200. Treating
    // either as "online" is the false signal this probe exists to remove.
    const shell = vi.fn(async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    });
    await expect(probeHost({ fetch: shell as unknown as typeof globalThis.fetch })).resolves.toBe(false);

    const impostor = vi.fn(async () => healthResponse({ service: 'something-else', status: 'ok' }));
    await expect(probeHost({ fetch: impostor as unknown as typeof globalThis.fetch })).resolves.toBe(false);

    const notFound = vi.fn(async () => healthResponse({ service: HOST_HEALTH_SERVICE }, false));
    await expect(probeHost({ fetch: notFound as unknown as typeof globalThis.fetch })).resolves.toBe(false);
  });

  it('reports unreachable instead of throwing when the host refuses the connection', async () => {
    const refused = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeHost({ fetch: refused as unknown as typeof globalThis.fetch })).resolves.toBe(false);
  });

  it('aborts a probe that outlives its bound', async () => {
    let observed: AbortSignal | undefined;
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observed = init.signal as AbortSignal;
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const result = await probeHost({ fetch: hang as unknown as typeof globalThis.fetch, timeoutMs: 5 });

    expect(result).toBe(false);
    expect(observed?.aborted).toBe(true);
  });
});

describe('host monitor lifecycle', () => {
  it('publishes only transitions, so a confirming poll announces nothing', async () => {
    const harness = controlledMonitor([async () => healthResponse({ service: HOST_HEALTH_SERVICE })]);

    harness.monitor.start();
    await vi.waitFor(() => expect(harness.changes).toEqual(['ONLINE']));

    harness.fire();
    await vi.waitFor(() => expect(harness.calls()).toBe(2));
    expect(harness.changes).toEqual(['ONLINE']);
    expect(harness.monitor.current()).toBe('ONLINE');

    harness.monitor.stop();
  });

  it('recovers after the desktop receiver is started again', async () => {
    let reachable = false;
    const harness = controlledMonitor([async () => (reachable
      ? healthResponse({ service: HOST_HEALTH_SERVICE })
      : Promise.reject(new TypeError('Failed to fetch')) as unknown as Response)]);

    harness.monitor.start();
    await vi.waitFor(() => expect(harness.changes).toEqual(['UNAVAILABLE']));
    // Unreachable retries sooner than a healthy host is re-checked.
    const unavailableDelay = harness.lastDelay()!;

    reachable = true;
    harness.fire();
    await vi.waitFor(() => expect(harness.changes).toEqual(['UNAVAILABLE', 'ONLINE']));
    expect(harness.lastDelay()!).toBeGreaterThan(unavailableDelay);

    harness.monitor.stop();
  });

  it('stops polling and ignores an in-flight probe once stopped', async () => {
    let release: ((response: Response) => void) | undefined;
    const harness = controlledMonitor([() => new Promise<Response>((resolve) => { release = resolve; })]);

    harness.monitor.start();
    await vi.waitFor(() => expect(release).toBeDefined());

    harness.monitor.stop();
    release!(healthResponse({ service: HOST_HEALTH_SERVICE }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.changes).toEqual([]);
    expect(harness.pending()).toBe(0);
  });

  it('re-probes immediately on refresh without stacking timers', async () => {
    const harness = controlledMonitor([async () => healthResponse({ service: HOST_HEALTH_SERVICE })]);

    harness.monitor.start();
    await vi.waitFor(() => expect(harness.calls()).toBe(1));

    harness.monitor.refresh();
    await vi.waitFor(() => expect(harness.calls()).toBe(2));
    // Exactly one timer, not one per refresh: the pending one is cancelled
    // before the immediate re-probe schedules its replacement.
    await vi.waitFor(() => expect(harness.pending()).toBe(1));

    harness.monitor.stop();
  });
});

describe('host status copy', () => {
  it('separates the cached app from the desktop host in every state', () => {
    expect(hostStatusCopy('CHECKING').label).toBe('Checking receiver');
    expect(hostStatusCopy('ONLINE').label).toBe('Receiver online');

    const unavailable = hostStatusCopy('UNAVAILABLE');
    expect(unavailable.label).toBe('Receiver unavailable');
    // The installed receiver still works offline; the copy must say so rather
    // than read as though the app itself is broken.
    expect(unavailable.detail).toContain('Offline app mode');
    expect(unavailable.detail).toContain('Start receiver');
  });
});
