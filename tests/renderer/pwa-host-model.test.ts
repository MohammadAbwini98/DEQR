import { describe, it, expect } from 'vitest';
import { presentPwaHost } from '../../src/renderer/pwa-host-model';
import { PwaHostStatusView } from '../../src/shared/types';

function status(overrides: Partial<PwaHostStatusView> = {}): PwaHostStatusView {
  return {
    state: 'stopped',
    running: false,
    url: null,
    addresses: [],
    subjectAltNames: [],
    certificateSource: null,
    error: null,
    ...overrides,
  };
}

const RUNNING = status({
  state: 'running',
  running: true,
  url: 'https://100.64.0.5:5174/',
  addresses: [
    { address: '100.64.0.5', interfaceName: 'Tailscale', kind: 'overlay', url: 'https://100.64.0.5:5174/' },
  ],
  certificateSource: 'stored',
});

describe('PWA host presentation', () => {
  it('disables the button until the first status arrives', () => {
    const view = presentPwaHost(null, null);

    expect(view.actionDisabled).toBe(true);
    expect(view.actionLabel).toBe('Start receiver');
    expect(view.showQr).toBe(false);
    expect(view.isFailure).toBe(false);
  });

  it('offers a start when stopped, and does not present it as a failure', () => {
    const view = presentPwaHost(status(), null);

    expect(view.actionKind).toBe('start');
    expect(view.actionLabel).toBe('Start receiver');
    expect(view.actionDisabled).toBe(false);
    expect(view.actionClassName).toBe('primary');
    expect(view.isFailure).toBe(false);
    expect(view.showQr).toBe(false);
    expect(view.hint).toContain('firewall');
  });

  it('shows a disabled starting state', () => {
    const view = presentPwaHost(status({ state: 'starting' }), null);

    expect(view.actionLabel).toBe('Starting…');
    expect(view.actionDisabled).toBe(true);
    expect(view.isFailure).toBe(false);
    expect(view.message).toContain('certificate');
  });

  it('shows the QR and a stop action when running with a reachable address', () => {
    const view = presentPwaHost(RUNNING, null);

    expect(view.showQr).toBe(true);
    expect(view.actionKind).toBe('stop');
    expect(view.actionLabel).toBe('Stop receiver');
    expect(view.actionClassName).toBe('secondary');
    expect(view.actionDisabled).toBe(false);
  });

  it('hides the QR when running with no address an iPhone could reach', () => {
    const view = presentPwaHost(status({ state: 'running', running: true, url: 'https://127.0.0.1:5174/' }), null);

    expect(view.showQr).toBe(false);
    expect(view.actionKind).toBe('stop');
    expect(view.isFailure).toBe(false);
    expect(view.message).toContain('no address an iPhone can reach');
  });

  it('shows a disabled stopping state', () => {
    const view = presentPwaHost({ ...RUNNING, state: 'stopping', running: false }, null);

    expect(view.actionLabel).toBe('Stopping…');
    expect(view.actionDisabled).toBe(true);
    expect(view.showQr).toBe(false);
    expect(view.isFailure).toBe(false);
  });

  it('surfaces a failure with a retry, and marks it as degraded', () => {
    const view = presentPwaHost(status({ state: 'failed', error: 'Nope.' }), null);

    expect(view.isFailure).toBe(true);
    expect(view.message).toBe('Nope.');
    expect(view.actionLabel).toBe('Try again');
    expect(view.actionKind).toBe('start');
    expect(view.actionDisabled).toBe(false);
    expect(view.hint).toContain('try again');
  });

  it('falls back to generic copy when a failure carries no reason', () => {
    const view = presentPwaHost(status({ state: 'failed' }), null);

    expect(view.message).toBe('The iPhone receiver could not be started.');
  });

  it('lets a pending action override a stale status', () => {
    const startingOverStopped = presentPwaHost(status(), 'starting');
    expect(startingOverStopped.actionLabel).toBe('Starting…');
    expect(startingOverStopped.actionDisabled).toBe(true);

    const stoppingOverRunning = presentPwaHost(RUNNING, 'stopping');
    expect(stoppingOverRunning.actionLabel).toBe('Stopping…');
    expect(stoppingOverRunning.showQr).toBe(false);
  });

  it('never tells anyone to restart DEQR, which is no longer how this works', () => {
    const states: PwaHostStatusView['state'][] = [
      'stopped',
      'starting',
      'running',
      'stopping',
      'failed',
    ];

    for (const state of states) {
      const view = presentPwaHost(status({ state }), null);
      expect(view.message).not.toContain('restart DEQR');
      expect(view.hint ?? '').not.toContain('restart DEQR');
    }
  });
});
