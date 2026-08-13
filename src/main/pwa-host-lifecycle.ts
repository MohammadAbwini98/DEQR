import { app } from 'electron';
import * as path from 'path';
import { collectLanAddresses, LanAddress } from './lan-addresses';
import { PwaCertificate, resolvePwaCertificate } from './pwa-certificate';
import {
  PWA_HOST_DEFAULT_PORT,
  PWA_HOST_FAILURE_MESSAGE,
  PwaHostStatus,
  RunningPwaHost,
  StartPwaHostOptions,
  failedPwaHostStatus,
  getPwaHostStatus,
  runningPwaHostStatus,
  setPwaHostStatus,
  startPwaHost,
  startingPwaHostStatus,
  stoppedPwaHostStatus,
  stoppingPwaHostStatus,
} from './pwa-host';

/**
 * Owns the running server handle and serializes start/stop.
 *
 * This lives apart from `pwa-host.ts` because it needs `app.getPath` and the
 * `__dirname`-relative asset root, and `pwa-host.ts` is deliberately free of
 * Electron so its transport tests need no mock. It lives apart from `index.ts`
 * because `ipc-handlers.ts` has to reach the same instance, and importing a
 * module singleton is how that file already reaches the status store.
 */
export interface PwaHostLifecycleDependencies {
  collectAddresses: () => LanAddress[];
  resolveCertificate: (addresses: string[]) => PwaCertificate;
  startHost: (options: StartPwaHostOptions) => Promise<RunningPwaHost>;
  resolveRootDirectory: () => string;
  port: number;
  /**
   * Yields to the event loop so the `starting` acknowledgement can be
   * dispatched before certificate generation blocks this process.
   */
  defer: () => Promise<void>;
  log: (line: string) => void;
  warn: (line: string) => void;
}

export interface PwaHostLifecycle {
  /**
   * Synchronous and total: transitions to `starting`, schedules the work, and
   * returns the new status immediately. Never throws and never rejects.
   */
  start(): PwaHostStatus;
  /** Idempotent, and safe to call while stopped or while a start is running. */
  stop(): Promise<PwaHostStatus>;
  /** Resolves once no start or stop is in flight. */
  settled(): Promise<PwaHostStatus>;
  isRunning(): boolean;
}

function defaultDependencies(): PwaHostLifecycleDependencies {
  return {
    collectAddresses: () => collectLanAddresses(),
    // `app` is only read here, at call time. Importing this module in a plain
    // Node test therefore touches nothing Electron-specific.
    resolveCertificate: (addresses) =>
      resolvePwaCertificate({
        storageDirectory: path.join(app.getPath('userData'), 'pwa-host'),
        addresses,
      }),
    startHost: startPwaHost,
    // dist/main/index.js -> dist/pwa
    resolveRootDirectory: () => path.join(__dirname, '..', 'pwa'),
    port: PWA_HOST_DEFAULT_PORT,
    defer: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };
}

export function createPwaHostLifecycle(
  overrides: Partial<PwaHostLifecycleDependencies> = {},
): PwaHostLifecycle {
  const deps: PwaHostLifecycleDependencies = { ...defaultDependencies(), ...overrides };

  let host: RunningPwaHost | null = null;
  // One flag for both directions. Two would let a stop race a start that has
  // not produced a handle yet, leaving an unreachable listening socket.
  let inFlight: Promise<PwaHostStatus> | null = null;

  const runStart = async (): Promise<PwaHostStatus> => {
    try {
      const addresses = deps.collectAddresses();
      const certificate = deps.resolveCertificate(addresses.map((entry) => entry.address));

      host = await deps.startHost({
        rootDirectory: deps.resolveRootDirectory(),
        certificate: certificate.certificate,
        privateKey: certificate.privateKey,
        port: deps.port,
      });

      const port = host.port;
      const candidates = addresses.map((entry) => ({
        address: entry.address,
        interfaceName: entry.interfaceName,
        kind: entry.kind,
        url: `https://${entry.address}:${port}/`,
      }));

      setPwaHostStatus(
        runningPwaHostStatus({
          url: candidates[0]?.url ?? `https://127.0.0.1:${port}/`,
          addresses: candidates,
          subjectAltNames: certificate.subjectAltNames,
          certificateSource: certificate.source,
        }),
      );

      deps.log(
        `DEQR_PWA_HOST_READY port=${port} certificate=${certificate.source} interfaces=${candidates.length} preferred=${candidates[0]?.kind ?? 'loopback'}`,
      );
    } catch (error) {
      // Leave `host` null so a retry re-runs the whole sequence.
      const reason = error instanceof Error ? error.name : 'unknown';
      setPwaHostStatus(failedPwaHostStatus(PWA_HOST_FAILURE_MESSAGE));
      deps.warn(`DEQR_PWA_HOST_UNAVAILABLE reason=${reason}`);
    }
    return getPwaHostStatus();
  };

  const runStop = async (): Promise<PwaHostStatus> => {
    const running = host;
    host = null;
    if (running) {
      await running.close();
    }
    setPwaHostStatus(stoppedPwaHostStatus());
    deps.log('DEQR_PWA_HOST_STOPPED');
    return getPwaHostStatus();
  };

  const start = (): PwaHostStatus => {
    // Coalesce rather than queue: a second press should not start a second
    // server, and a start arriving during a stop must not undo the stop.
    if (inFlight || host) {
      return getPwaHostStatus();
    }

    setPwaHostStatus(startingPwaHostStatus());
    deps.log('DEQR_PWA_HOST_STARTING');

    const pending = deps
      .defer()
      .then(runStart)
      .finally(() => {
        if (inFlight === pending) {
          inFlight = null;
        }
      });
    inFlight = pending;
    // `runStart` absorbs its own failures; this is belt and braces.
    void pending.catch(() => undefined);

    return getPwaHostStatus();
  };

  const stop = (): Promise<PwaHostStatus> => {
    // Stop chains where start coalesces, so when the two race the settled
    // outcome is always stopped. Bounded: start refuses to run while in flight.
    if (inFlight) {
      return inFlight.then(() => stop());
    }
    if (!host) {
      return Promise.resolve(getPwaHostStatus());
    }

    setPwaHostStatus(stoppingPwaHostStatus(getPwaHostStatus()));

    const pending = runStop().finally(() => {
      if (inFlight === pending) {
        inFlight = null;
      }
    });
    inFlight = pending;
    return pending;
  };

  return {
    start,
    stop,
    settled: () =>
      inFlight ? inFlight.then(() => getPwaHostStatus()) : Promise.resolve(getPwaHostStatus()),
    isRunning: () => host !== null,
  };
}

/** The process-wide instance shared by `index.ts` and `ipc-handlers.ts`. */
export const pwaHostLifecycle: PwaHostLifecycle = createPwaHostLifecycle();
