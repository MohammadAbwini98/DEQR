import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDiagnosticsEnabled, setDiagnosticsEnabled, diagnosticsLabel, DIAGNOSTICS_STORAGE_KEY } from '../../src/shared/diagnostics-mode';

function mockWindow(href = 'http://localhost/'): { window: unknown; storage: Map<string, string> } {
  const storage = new Map<string, string>();
  const mock = {
    location: { href },
    history: {
      replaceState: (_a: unknown, _b: string, url: string) => {
        if (url.startsWith('/')) mock.location.href = 'http://localhost' + url;
        else if (url.startsWith('http')) mock.location.href = url;
        else mock.location.href = url;
      },
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
  };
  (globalThis as unknown as { window: unknown }).window = mock;
  return { window: mock, storage };
}

describe('diagnostics-mode', () => {
  let originalWindow: unknown;
  beforeEach(() => {
    originalWindow = (globalThis as unknown as { window?: unknown }).window;
    mockWindow('http://localhost/');
    try { (globalThis as unknown as { window: { localStorage: { removeItem(k:string):void } } }).window.localStorage.removeItem(DIAGNOSTICS_STORAGE_KEY); } catch {}
    vi.stubEnv('DEQR_DIAGNOSTICS', '');
  });
  afterEach(() => {
    try { (globalThis as unknown as { window: { localStorage: { removeItem(k:string):void } } }).window.localStorage.removeItem(DIAGNOSTICS_STORAGE_KEY); } catch {}
    if (originalWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window: unknown }).window = originalWindow;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('disabled by default', () => {
    expect(isDiagnosticsEnabled()).toBe(false);
    expect(diagnosticsLabel(false)).toBe('PRODUCTION');
  });

  it('enabled via localStorage', () => {
    setDiagnosticsEnabled(true);
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(diagnosticsLabel(true)).toContain('DIAGNOSTICS');
    setDiagnosticsEnabled(false);
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it('enabled via URL param', () => {
    mockWindow('http://localhost/?diag=1');
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it('labels itself clearly when enabled', () => {
    expect(diagnosticsLabel(true)).toMatch(/DIAGNOSTICS/);
    expect(diagnosticsLabel(false)).toMatch(/PRODUCTION/);
  });

  it('never changes protocol semantics (pure query, no fetch)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation(() => Promise.resolve(new Response()));
    isDiagnosticsEnabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
