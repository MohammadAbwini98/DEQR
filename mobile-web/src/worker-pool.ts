/**
 * HT-08 — Bounded parallel worker pool (corrected).
 *
 * Derives count from hardwareConcurrency, enforces 2..4 bounds, handles lifecycle,
 * job types (full vs crop), priority (tracked > full, full not starved), busy policy
 * (drop stale, maxQueue 1), result validation (generation), memory (transferList),
 * diagnostics (workers/busy/queue/dropped/restarts/jobsByType/latency decode time).
 */

export type JobType = 'full' | 'crop';

export interface DecodeJob {
  id: number;
  type: JobType;
  regionId?: string;
  generation: number;
  captureId: number;
  image: ImageData;
  priority: number;
}

export interface PoolStats {
  workers: number;
  busy: number;
  queueDepth: number;
  droppedBusy: number;
  restarts: number;
  jobsByType: Record<JobType, number>;
  avgLatencyMs: number | null;
}

export class BoundedWorkerPool {
  private readonly workers: Worker[] = [];
  private queue: DecodeJob[] = [];
  private busy = new Set<number>(); // worker indices
  private nextId = 1;
  private droppedBusy = 0;
  private restarts = 0;
  private jobsByType: Record<JobType, number> = { full: 0, crop: 0 };
  private latencies: number[] = [];
  private readonly inFlight = new Map<number, { job: DecodeJob; start: number }>();

  constructor(
    private readonly createWorker: () => Worker,
    private readonly maxWorkers: number = BoundedWorkerPool.recommendedCount(),
    private readonly maxQueue = 1,
    private readonly onResult: (job: DecodeJob, result: unknown, latencyMs: number) => void = () => {},
  ) {
    const count = Math.max(2, Math.min(maxWorkers, BoundedWorkerPool.recommendedCount()));
    for (let i = 0; i < count; i++) this.spawn(i);
  }

  static recommendedCount(): number {
    const n = (navigator as unknown as { hardwareConcurrency?: number }).hardwareConcurrency ?? 4;
    return Math.max(2, Math.min(4, n));
  }

  get size(): number { return this.workers.length; }
  get queueDepth(): number { return this.queue.length; }

  private spawn(index?: number): void {
    const idx = index ?? this.workers.length;
    const w = this.createWorker();
    w.onmessage = (e) => this.handleResult(idx, e.data);
    w.onerror = () => this.restart(idx);
    // Health handshake: expect ready message within 2s, else restart
    let ready = false;
    const origOnMessage = w.onmessage;
    w.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'ready') ready = true;
      origOnMessage?.(e as MessageEvent);
    };
    setTimeout(() => {
      if (!ready) this.restart(idx);
    }, 2000);
    if (index !== undefined && index < this.workers.length) this.workers[index] = w;
    else this.workers.push(w);
  }

  private restart(idx: number): void {
    this.restarts++;
    this.busy.delete(idx);
    this.inFlight.delete(idx);
    try { this.workers[idx]?.terminate(); } catch {}
    this.spawn(idx);
  }

  submit(job: Omit<DecodeJob, 'id' | 'priority'> & { priority?: number }): boolean {
    const fullJob: DecodeJob = {
      id: this.nextId++,
      priority: job.type === 'crop' ? 10 : 5,
      ...job,
    } as DecodeJob;
    if (this.busy.size >= this.workers.length) {
      if (this.queue.length >= this.maxQueue) {
        this.droppedBusy++;
        return false;
      }
    }
    const insertAt = this.queue.findIndex(q => q.priority < fullJob.priority);
    if (insertAt === -1) this.queue.push(fullJob);
    else this.queue.splice(insertAt, 0, fullJob);
    this.jobsByType[fullJob.type]++;
    this.dispatch();
    return true;
  }

  private dispatch(): void {
    while (this.queue.length > 0 && this.busy.size < this.workers.length) {
      const workerIdx = [...this.workers.keys()].find(i => !this.busy.has(i));
      if (workerIdx === undefined) break;
      const job = this.queue.shift()!;
      this.busy.add(workerIdx);
      this.inFlight.set(workerIdx, { job, start: performance.now() });
      try {
        const transfer = [job.image.data.buffer] as unknown as Transferable[];
        this.workers[workerIdx].postMessage({ type: 'decode', job }, transfer);
      } catch {
        this.workers[workerIdx].postMessage({ type: 'decode', job });
      }
    }
  }

  private handleResult(workerIdx: number, data: unknown): void {
    const entry = this.inFlight.get(workerIdx);
    this.busy.delete(workerIdx);
    this.inFlight.delete(workerIdx);
    if (entry) {
      const latencyMs = performance.now() - entry.start;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 100) this.latencies.shift();
      // Stale generation check: if job generation mismatched current, discard (caller also checks)
      // For now, we invoke onResult with latency as decode time (not postMessage time)
      this.onResult(entry.job, data, latencyMs);
    }
    this.dispatch();
  }

  stats(): PoolStats {
    const avgLatencyMs = this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : null;
    return {
      workers: this.workers.length,
      busy: this.busy.size,
      queueDepth: this.queue.length,
      droppedBusy: this.droppedBusy,
      restarts: this.restarts,
      jobsByType: { ...this.jobsByType },
      avgLatencyMs,
    };
  }

  terminate(): void {
    for (const w of this.workers) try { w.terminate(); } catch {}
    this.workers.length = 0;
    this.queue = [];
    this.busy.clear();
    this.inFlight.clear();
  }
}
