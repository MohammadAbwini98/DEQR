import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ORIGIN = 'https://100.95.40.3:5174';
const SW_PATH = path.resolve(__dirname, '..', 'public/sw.js');

/** `type` is only set by `Response.error()`, which is why it is optional. */
interface FakeResponse { ok: boolean; status: number; tag: string; type?: string; clone(): FakeResponse }

function makeResponse(tag: string, ok = true): FakeResponse {
  const response: FakeResponse = { ok, status: ok ? 200 : 503, tag, clone: () => makeResponse(tag, ok) };
  return response;
}

function makeRequest(pathname: string, options: { mode?: string; destination?: string; method?: string } = {}) {
  return {
    url: new URL(pathname, ORIGIN).href,
    method: options.method ?? 'GET',
    mode: options.mode ?? 'no-cors',
    destination: options.destination ?? '',
  };
}

/**
 * Runs the real `sw.js` rather than asserting on its text. A cache strategy is
 * behaviour, and the defect this replaces — a shell that could never update —
 * was invisible in every string the file contained.
 */
async function loadWorker() {
  const source = await readFile(SW_PATH, 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, FakeResponse>>();
  const network = new Map<string, FakeResponse>();
  const fetched: string[] = [];
  let networkDown = false;

  const keyFor = (request: unknown): string =>
    typeof request === 'string' ? new URL(request, ORIGIN).href : (request as { url: string }).url;

  const cacheApi = (name: string) => {
    const store = stores.get(name) ?? new Map<string, FakeResponse>();
    stores.set(name, store);
    return {
      addAll: async (urls: string[]) => { for (const url of urls) store.set(keyFor(url), makeResponse('precached:' + url)); },
      put: async (request: unknown, response: FakeResponse) => { store.set(keyFor(request), response); },
      match: async (request: unknown) => store.get(keyFor(request)),
      delete: async (request: unknown) => store.delete(keyFor(request)),
    };
  };

  const skipWaiting = vi.fn();
  const claim = vi.fn();
  const posted: Array<Record<string, unknown>> = [];
  const context = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
      skipWaiting,
      clients: {
        claim,
        matchAll: async () => [{ postMessage: (message: Record<string, unknown>) => posted.push(message) }],
      },
    },
    caches: {
      open: async (name: string) => cacheApi(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: async (request: unknown) => {
      const url = keyFor(request);
      fetched.push(url);
      if (networkDown) throw new TypeError('Failed to fetch');
      return network.get(url) ?? makeResponse('network:' + url);
    },
    // `Response.error()` is a real network error, which is what makes the
    // browser fire `error` on a script element. A plain Response never does.
    Response: Object.assign(
      class { constructor(public body: unknown, public init?: { status?: number }) {} },
      { error: () => ({ ok: false, status: 0, type: 'error', tag: 'network-error' }) },
    ),
    URL,
    Promise,
    console,
  };

  vm.createContext(context);
  vm.runInContext(source, context);

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Array<Promise<unknown>> = [];
    const responses: Array<Promise<FakeResponse>> = [];
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      respondWith: (promise: Promise<FakeResponse>) => responses.push(promise),
    });
    await Promise.all(waits);
    return responses;
  };

  return {
    dispatch,
    stores,
    network,
    fetched,
    posted,
    skipWaiting,
    claim,
    setNetworkDown: (down: boolean) => { networkDown = down; },
    cacheNames: () => [...stores.keys()],
    async install() { await dispatch('install', {}); },
    async activate() { await dispatch('activate', {}); },
    async request(request: ReturnType<typeof makeRequest>) {
      const responses = await dispatch('fetch', { request });
      return responses.length ? await responses[0] : undefined;
    },
  };
}

describe('receiver service worker strategy', () => {
  let sw: Awaited<ReturnType<typeof loadWorker>>;

  beforeEach(async () => {
    sw = await loadWorker();
  });

  it('still installs when a precache fetch fails', async () => {
    // `cache.addAll` is atomic: one failed fetch rejects the batch, the install
    // fails, and the previous worker stays in charge for good — including the
    // one whose cached shell this update exists to replace.
    sw.setNetworkDown(true);
    await expect(sw.install()).resolves.not.toThrow();
    expect(sw.skipWaiting).toHaveBeenCalled();

    await sw.activate();
    expect(sw.claim).toHaveBeenCalled();

    // And with the worker in charge, the document is served from the network.
    sw.setNetworkDown(false);
    sw.network.set(ORIGIN + '/', makeResponse('fresh-shell'));
    const response = await sw.request(makeRequest('/', { mode: 'navigate', destination: 'document' }));
    expect(response?.tag).toBe('fresh-shell');
  });

  it('takes over immediately and evicts every earlier shell cache', async () => {
    sw.stores.set('deqr-mobile-shell-v1', new Map([[ORIGIN + '/index.html', makeResponse('stale-shell')]]));

    await sw.install();
    expect(sw.skipWaiting).toHaveBeenCalled();

    await sw.activate();
    expect(sw.cacheNames()).not.toContain('deqr-mobile-shell-v1');
    expect(sw.claim).toHaveBeenCalled();
  });

  it('serves the live shell for a navigation instead of a cached one', async () => {
    await sw.install();
    const cache = sw.stores.get('deqr-mobile-shell-v3')!;
    cache.set(ORIGIN + '/', makeResponse('stale-shell'));
    cache.set(ORIGIN + '/index.html', makeResponse('stale-shell'));
    sw.network.set(ORIGIN + '/', makeResponse('fresh-shell'));

    const response = await sw.request(makeRequest('/', { mode: 'navigate', destination: 'document' }));

    // The whole defect: an installed phone could never be given a new build.
    expect(response?.tag).toBe('fresh-shell');
    expect(sw.fetched).toContain(ORIGIN + '/');
    expect(cache.get(ORIGIN + '/')?.tag).toBe('fresh-shell');
    expect(cache.get(ORIGIN + '/index.html')?.tag).toBe('fresh-shell');
  });

  it('still opens from cache when the desktop host is stopped', async () => {
    await sw.install();
    const cache = sw.stores.get('deqr-mobile-shell-v3')!;
    cache.set(ORIGIN + '/', makeResponse('cached-shell'));
    cache.set(ORIGIN + '/index.html', makeResponse('cached-shell'));
    sw.setNetworkDown(true);

    // Offline installability is a requirement, not a side effect to trade away.
    const direct = await sw.request(makeRequest('/', { mode: 'navigate', destination: 'document' }));
    expect(direct?.tag).toBe('cached-shell');

    // A deep link has no cache entry of its own and must still reach the shell.
    const route = await sw.request(makeRequest('/receive', { mode: 'navigate', destination: 'document' }));
    expect(route?.tag).toBe('cached-shell');
  });

  it('never answers the health probe, so reachability cannot be remembered', async () => {
    await sw.install();
    sw.stores.get('deqr-mobile-shell-v3')!.set(ORIGIN + '/health', makeResponse('cached-health'));

    const response = await sw.request(makeRequest('/health'));

    expect(response).toBeUndefined();
    expect(sw.fetched).not.toContain(ORIGIN + '/health');
  });

  it('serves hashed build assets from cache without a network round trip', async () => {
    await sw.install();
    sw.stores.get('deqr-mobile-shell-v3')!.set(ORIGIN + '/assets/index-abc123.js', makeResponse('cached-asset'));

    // Count only what this request causes; install precaches over the network.
    const before = sw.fetched.length;
    const response = await sw.request(makeRequest('/assets/index-abc123.js', { destination: 'script' }));

    expect(response?.tag).toBe('cached-asset');
    expect(sw.fetched.length - before, 'a hashed asset must not hit the network').toBe(0);
  });

  it('refreshes unhashed assets in the background while answering from cache', async () => {
    await sw.install();
    const cache = sw.stores.get('deqr-mobile-shell-v3')!;
    cache.set(ORIGIN + '/icons/deqr.svg', makeResponse('cached-icon'));
    sw.network.set(ORIGIN + '/icons/deqr.svg', makeResponse('fresh-icon'));

    const response = await sw.request(makeRequest('/icons/deqr.svg', { destination: 'image' }));

    expect(response?.tag).toBe('cached-icon');
    await vi.waitFor(() => expect(cache.get(ORIGIN + '/icons/deqr.svg')?.tag).toBe('fresh-icon'));
  });

  it('ignores non-GET and cross-origin requests entirely', async () => {
    await sw.install();

    expect(await sw.request(makeRequest('/', { method: 'POST' }))).toBeUndefined();
    const foreign = { url: 'https://example.invalid/probe', method: 'GET', mode: 'no-cors', destination: '' };
    expect(await sw.request(foreign)).toBeUndefined();
  });
});

describe('stale-shell recovery', () => {
  let sw: Awaited<ReturnType<typeof loadWorker>>;

  beforeEach(async () => {
    sw = await loadWorker();
    await sw.install();
    await sw.activate();
  });

  it('never synthesises a response body for a build asset that failed to load', async () => {
    // The permanent-white-page defect. A fake `503 Offline` body is still a
    // response, so the browser MIME-checks it, rejects it, and fires nothing
    // the page can observe. A real network error is what fires `error` on the
    // script element, which is the only signal `boot.js` can recover from.
    sw.setNetworkDown(true);

    const response = await sw.request(makeRequest('/assets/index-abc123.js'));

    expect(response?.type).toBe('error');
    expect(response?.tag).not.toBe('Offline');
  });

  it('reports a stale shell and evicts it when a hashed asset is gone from the host', async () => {
    // A cached document naming a build the host no longer has. Left alone this
    // reloads into the same cached shell forever.
    const cache = sw.stores.get('deqr-mobile-shell-v3')!;
    cache.set(ORIGIN + '/', makeResponse('stale-shell'));
    cache.set(ORIGIN + '/index.html', makeResponse('stale-shell'));
    sw.network.set(ORIGIN + '/assets/index-OLDHASH.js', makeResponse('missing', false));

    await sw.request(makeRequest('/assets/index-OLDHASH.js'));

    expect(sw.posted).toContainEqual(
      expect.objectContaining({ type: 'DEQR_SHELL_STALE', asset: ORIGIN + '/assets/index-OLDHASH.js' }),
    );
    // Evicting the shell is what stops the next navigation landing right back
    // on the same dead build.
    expect(cache.get(ORIGIN + '/')).toBeUndefined();
    expect(cache.get(ORIGIN + '/index.html')).toBeUndefined();
  });

  it('does not cry stale for a missing non-build file', async () => {
    // A 404 on an icon or an unknown route says nothing about the build, and
    // treating it as a version mismatch would reload the app for nothing.
    sw.network.set(ORIGIN + '/icons/absent.png', makeResponse('missing', false));

    await sw.request(makeRequest('/icons/absent.png'));

    expect(sw.posted).toHaveLength(0);
  });

  it('precaches the recovery script, which must survive offline', async () => {
    // `boot.js` is the only code that can recover a shell whose hashed module
    // is gone, so it cannot itself be hashed or network-dependent.
    expect(sw.fetched.some((url) => url.endsWith('/boot.js'))).toBe(true);
  });
});
