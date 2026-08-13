import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ORIGIN = 'https://100.95.40.3:5174';
const SW_PATH = path.resolve(__dirname, '..', 'public/sw.js');

interface FakeResponse { ok: boolean; status: number; tag: string; clone(): FakeResponse }

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
    };
  };

  const skipWaiting = vi.fn();
  const claim = vi.fn();
  const context = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
      skipWaiting,
      clients: { claim },
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
    Response: class { constructor(public body: unknown, public init?: { status?: number }) {} },
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
    const cache = sw.stores.get('deqr-mobile-shell-v2')!;
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
    const cache = sw.stores.get('deqr-mobile-shell-v2')!;
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
    sw.stores.get('deqr-mobile-shell-v2')!.set(ORIGIN + '/health', makeResponse('cached-health'));

    const response = await sw.request(makeRequest('/health'));

    expect(response).toBeUndefined();
    expect(sw.fetched).not.toContain(ORIGIN + '/health');
  });

  it('serves hashed build assets from cache without a network round trip', async () => {
    await sw.install();
    sw.stores.get('deqr-mobile-shell-v2')!.set(ORIGIN + '/assets/index-abc123.js', makeResponse('cached-asset'));

    const response = await sw.request(makeRequest('/assets/index-abc123.js', { destination: 'script' }));

    expect(response?.tag).toBe('cached-asset');
    expect(sw.fetched).toHaveLength(0);
  });

  it('refreshes unhashed assets in the background while answering from cache', async () => {
    await sw.install();
    const cache = sw.stores.get('deqr-mobile-shell-v2')!;
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
