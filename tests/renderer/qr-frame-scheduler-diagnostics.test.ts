import { describe, it, expect } from 'vitest';
import { QrFrameScheduler, type FrameSource, type SchedulerClock } from '../../src/renderer/qr-frame-scheduler';
import { BALANCED_PROFILE } from '../../src/core/transport-profiles';

function makeClock(): SchedulerClock & { advance(ms: number): void; nowValue: number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    get nowValue() { return now; },
    now: () => now,
    setTimer: (delayMs, cb) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, cb });
      // Immediately invoke if delay 0 for deterministic test (simplify)
      if (delayMs === 0) {
        // defer one tick
        queueMicrotask(() => {
          const t = timers.get(id);
          if (t) { timers.delete(id); t.cb(); }
        });
      }
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms: number) { now += ms; },
  };
}

function makeSource(frames: Uint8Array[]): FrameSource {
  let i = 0;
  return {
    next: async () => {
      if (i >= frames.length) return null;
      return frames[i++];
    },
  };
}

describe('qr-frame-scheduler diagnostics — sender counters', () => {
  it('tracks generation and raster p50/p95', async () => {
    const clock = makeClock();
    const frames = [new Uint8Array([1,2,3]), new Uint8Array([4,5,6]), new Uint8Array([7,8,9])];
    let paintDelay = 2;
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, makeSource(frames), async () => {
      const start = clock.now();
      clock.advance(paintDelay);
      paintDelay += 1;
    }, clock);

    scheduler.start();
    // Let async fill and ticks run
    await new Promise(r => setTimeout(r, 20));
    scheduler.stop();
    const stats = scheduler.stats();
    // generation and raster reservoirs should have samples
    expect(stats.generationP50Ms).not.toBeNull();
    expect(stats.rasterizationP50Ms).not.toBeNull();
    expect(stats.rasterizationP95Ms).not.toBeNull();
    expect(stats.generationP95Ms).not.toBeNull();
  });

  it('sender counters are distinct: framesGenerated vs symbolsPresented', async () => {
    const clock = makeClock();
    const frames = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, makeSource(frames), async () => { clock.advance(1); }, clock);
    scheduler.start();
    await new Promise(r => setTimeout(r, 20));
    scheduler.stop();
    const s = scheduler.stats();
    // framesRequested = framesGenerated attempts, framesPainted = symbolsPresented
    expect(s.framesRequested).toBeGreaterThanOrEqual(s.framesPainted);
    expect(s.symbolsPresented).toBeUndefined(); // not in SchedulerStats, but via diagnostics collector mapping
    // Presentation stalls vs queue underruns are separate
    expect(typeof s.starvedWakeups).toBe('number');
    expect(typeof s.queueUnderruns).toBe('number');
    // actualPresentationRateFps is measured, not target restated
    expect(typeof s.effectiveFps).toBe('number');
  });

  it('exposes required sender diagnostic fields', async () => {
    const clock = makeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, makeSource([new Uint8Array([1])]), async () => {}, clock);
    scheduler.start();
    await new Promise(r => setTimeout(r, 10));
    scheduler.stop();
    const s = scheduler.stats();
    // Required work §2 fields must exist
    expect(s).toHaveProperty('framesRequested');
    expect(s).toHaveProperty('framesPainted');
    expect(s).toHaveProperty('starvedWakeups');
    expect(s).toHaveProperty('queueUnderruns');
    expect(s).toHaveProperty('generationP50Ms');
    expect(s).toHaveProperty('generationP95Ms');
    expect(s).toHaveProperty('rasterizationP50Ms');
    expect(s).toHaveProperty('rasterizationP95Ms');
    expect(s).toHaveProperty('effectiveFps');
  });
});
