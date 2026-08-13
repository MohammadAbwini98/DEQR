/**
 * Reachability of the desktop receiver host.
 *
 * An installed DEQR receiver is deliberately usable with no host at all, so
 * "the app opened" says nothing about whether the desktop is publishing. This
 * measures that separately, against the one endpoint the host answers.
 */
export type HostStatus = 'CHECKING' | 'ONLINE' | 'UNAVAILABLE';

export const HOST_HEALTH_URL = './health';
/** The host's constant marker. Anything else is not a DEQR receiver host. */
export const HOST_HEALTH_SERVICE = 'deqr-pwa-host';

export const HOST_PROBE_TIMEOUT_MS = 4_000;
/** Quiet while it is working; quick enough to notice a desktop Start press. */
export const HOST_POLL_ONLINE_MS = 20_000;
export const HOST_POLL_UNAVAILABLE_MS = 6_000;

export interface HostProbeDeps {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * A bare `response.ok` is not enough. A single-page fallback, a captive portal,
 * or a cached shell can all answer 200 with HTML, and treating that as "online"
 * is exactly the false signal this replaces. Only the host's own marker counts.
 */
export async function probeHost(deps: HostProbeDeps): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? HOST_PROBE_TIMEOUT_MS);
  try {
    const response = await deps.fetch(HOST_HEALTH_URL, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && (body as { service?: unknown }).service === HOST_HEALTH_SERVICE;
  } catch {
    // A refused connection, a DNS failure, a timeout, and a non-JSON body are
    // one fact to the user: the desktop receiver is not reachable right now.
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface HostMonitorDeps extends HostProbeDeps {
  onChange: (status: HostStatus) => void;
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  onlineIntervalMs?: number;
  unavailableIntervalMs?: number;
}

/**
 * Polls while the page is visible. Only transitions are published, so an
 * assistive-technology live region tied to this never repeats itself.
 */
export class HostMonitor {
  private status: HostStatus = 'CHECKING';
  private timer?: number;
  private running = false;
  private generation = 0;

  constructor(private readonly deps: HostMonitorDeps) {}

  current(): HostStatus {
    return this.status;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.check();
  }

  /** Called when the page becomes visible again; re-probes without waiting. */
  refresh(): void {
    if (!this.running) return;
    this.cancelTimer();
    void this.check();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(next: HostStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.deps.onChange(next);
  }

  private async check(): Promise<void> {
    const generation = ++this.generation;
    const reachable = await probeHost(this.deps);
    if (!this.running || generation !== this.generation) return;

    this.publish(reachable ? 'ONLINE' : 'UNAVAILABLE');
    const delay = reachable
      ? this.deps.onlineIntervalMs ?? HOST_POLL_ONLINE_MS
      : this.deps.unavailableIntervalMs ?? HOST_POLL_UNAVAILABLE_MS;
    this.timer = this.deps.setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delay);
  }
}

export interface HostStatusCopy {
  label: string;
  detail: string;
}

export function hostStatusCopy(status: HostStatus): HostStatusCopy {
  if (status === 'CHECKING') {
    return { label: 'Checking receiver', detail: 'Looking for the DEQR desktop receiver on this network.' };
  }
  if (status === 'ONLINE') {
    return { label: 'Receiver online', detail: 'The DEQR desktop receiver is reachable from this iPhone.' };
  }
  return {
    label: 'Receiver unavailable',
    detail: 'Offline app mode. Scanning still works. To reconnect, press Start receiver in the DEQR desktop app.',
  };
}
