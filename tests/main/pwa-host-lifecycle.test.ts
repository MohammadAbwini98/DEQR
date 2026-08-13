import { describe, it, expect, vi, beforeEach } from 'vitest';

// The lifecycle module reads `app.getPath` only inside its default certificate
// resolver, which every test below replaces. The mock exists so the import
// itself succeeds outside Electron.
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\test\\userData' },
}));

import { createPwaHostLifecycle, PwaHostLifecycleDependencies } from '../../src/main/pwa-host-lifecycle';
import {
  PWA_HOST_FAILURE_MESSAGE,
  PwaHostStatus,
  RunningPwaHost,
  getPwaHostStatus,
  resetPwaHostStatus,
  subscribePwaHostStatus,
} from '../../src/main/pwa-host';
import type { LanAddress } from '../../src/main/lan-addresses';
import type { PwaCertificate } from '../../src/main/pwa-certificate';

const ADDRESSES: LanAddress[] = [
  { address: '100.64.0.5', interfaceName: 'Tailscale', kind: 'overlay' },
  { address: '192.168.1.20', interfaceName: 'Wi-Fi', kind: 'private' },
];

const CERTIFICATE: PwaCertificate = {
  certificate: 'CERT',
  privateKey: 'KEY',
  subjectAltNames: ['100.64.0.5', '192.168.1.20'],
  source: 'generated',
};

function buildLifecycle(overrides: Partial<PwaHostLifecycleDependencies> = {}) {
  const close = vi.fn(async () => undefined);
  const startHost = vi.fn(async (): Promise<RunningPwaHost> => ({ port: 5174, close }));
  const collectAddresses = vi.fn(() => ADDRESSES);
  const resolveCertificate = vi.fn(() => CERTIFICATE);

  const lifecycle = createPwaHostLifecycle({
    collectAddresses,
    resolveCertificate,
    startHost,
    resolveRootDirectory: () => 'C:\\dist\\pwa',
    port: 5174,
    // Resolve immediately: the deferral is an event-loop courtesy, not a
    // behaviour under test except in the ordering case below.
    defer: () => Promise.resolve(),
    log: () => undefined,
    warn: () => undefined,
    ...overrides,
  });

  return { lifecycle, startHost, close, collectAddresses, resolveCertificate };
}

describe('PWA host lifecycle', () => {
  beforeEach(() => {
    resetPwaHostStatus();
  });

  it('does nothing until asked, so the app publishes nothing at launch', () => {
    const { startHost, resolveCertificate } = buildLifecycle();

    expect(getPwaHostStatus().state).toBe('stopped');
    expect(getPwaHostStatus().running).toBe(false);
    expect(resolveCertificate).not.toHaveBeenCalled();
    expect(startHost).not.toHaveBeenCalled();
  });

  it('acknowledges the start synchronously, before the blocking work runs', () => {
    const { lifecycle, resolveCertificate } = buildLifecycle();

    const acknowledgement = lifecycle.start();

    expect(acknowledgement.state).toBe('starting');
    expect(acknowledgement.running).toBe(false);
    // The certificate work is deferred, so it cannot have run yet.
    expect(resolveCertificate).not.toHaveBeenCalled();
  });

  it('reaches running with the addresses and certificate details populated', async () => {
    const { lifecycle } = buildLifecycle();

    lifecycle.start();
    const status = await lifecycle.settled();

    expect(status.state).toBe('running');
    expect(status.running).toBe(true);
    expect(status.url).toBe('https://100.64.0.5:5174/');
    expect(status.addresses).toHaveLength(2);
    expect(status.addresses[0].kind).toBe('overlay');
    expect(status.subjectAltNames).toEqual(CERTIFICATE.subjectAltNames);
    expect(status.certificateSource).toBe('generated');
    expect(status.error).toBeNull();
    expect(lifecycle.isRunning()).toBe(true);
  });

  it('coalesces a double start into a single server', async () => {
    const { lifecycle, startHost } = buildLifecycle();

    lifecycle.start();
    lifecycle.start();
    await lifecycle.settled();

    expect(startHost).toHaveBeenCalledTimes(1);
  });

  it('treats a start while already running as a no-op', async () => {
    const { lifecycle, startHost } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();
    lifecycle.start();
    await lifecycle.settled();

    expect(startHost).toHaveBeenCalledTimes(1);
    expect(getPwaHostStatus().state).toBe('running');
  });

  it('clears the published details when stopped', async () => {
    const { lifecycle, close } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();
    const status = await lifecycle.stop();

    expect(close).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('stopped');
    expect(status.running).toBe(false);
    expect(status.url).toBeNull();
    expect(status.addresses).toEqual([]);
    expect(status.error).toBeNull();
    expect(lifecycle.isRunning()).toBe(false);
  });

  it('closes once for a double stop', async () => {
    const { lifecycle, close } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();
    const [first, second] = await Promise.all([lifecycle.stop(), lifecycle.stop()]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(first.state).toBe('stopped');
    expect(second.state).toBe('stopped');
  });

  it('lets a stop issued during a start complete the start and then close it', async () => {
    const { lifecycle, startHost, close } = buildLifecycle();

    lifecycle.start();
    const status = await lifecycle.stop();

    expect(startHost).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('stopped');
    expect(lifecycle.isRunning()).toBe(false);
  });

  it('drops a start issued during a stop, so stop wins the race', async () => {
    const { lifecycle, startHost } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();

    const stopping = lifecycle.stop();
    lifecycle.start();
    await stopping;
    await lifecycle.settled();

    expect(startHost).toHaveBeenCalledTimes(1);
    expect(getPwaHostStatus().state).toBe('stopped');
    expect(lifecycle.isRunning()).toBe(false);
  });

  it('fails with a redacted message when the certificate cannot be resolved', async () => {
    const { lifecycle, startHost } = buildLifecycle({
      resolveCertificate: vi.fn(() => {
        throw new Error('ENOENT: C:\\Users\\someone\\AppData\\pwa-host\\deqr-pwa-host-key.pem');
      }),
    });

    lifecycle.start();
    const status = await lifecycle.settled();

    expect(status.state).toBe('failed');
    expect(status.error).toBe(PWA_HOST_FAILURE_MESSAGE);
    expect(startHost).not.toHaveBeenCalled();

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('AppData');
    expect(serialized).not.toContain('.pem');
    expect(serialized).not.toContain('ENOENT');
  });

  it('fails on a taken port and retries on the next start', async () => {
    const startHost = vi
      .fn<[], Promise<RunningPwaHost>>()
      .mockRejectedValueOnce(Object.assign(new Error('listen EADDRINUSE'), { name: 'Error' }))
      .mockResolvedValueOnce({ port: 5174, close: vi.fn(async () => undefined) });
    const { lifecycle } = buildLifecycle({ startHost: startHost as never });

    lifecycle.start();
    expect((await lifecycle.settled()).state).toBe('failed');

    lifecycle.start();
    const status = await lifecycle.settled();

    expect(startHost).toHaveBeenCalledTimes(2);
    expect(status.state).toBe('running');
    expect(status.error).toBeNull();
  });

  it('keeps the running invariant across every transition', async () => {
    const seen: PwaHostStatus[] = [];
    const unsubscribe = subscribePwaHostStatus((status) => seen.push(status));
    const { lifecycle } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();
    await lifecycle.stop();
    unsubscribe();

    expect(seen.length).toBeGreaterThan(0);
    for (const status of seen) {
      expect(status.running).toBe(status.state === 'running');
    }
  });

  it('broadcasts the transitions in order', async () => {
    const states: string[] = [];
    const unsubscribe = subscribePwaHostStatus((status) => states.push(status.state));
    const { lifecycle } = buildLifecycle();

    lifecycle.start();
    await lifecycle.settled();
    await lifecycle.stop();
    unsubscribe();

    expect(states).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });
});
