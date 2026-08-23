import { describe, expect, it } from 'vitest';

import { BALANCED_PROFILE, TURBO_PROFILE, effectiveFps } from '../../src/core/transport-profiles';
import {
  FrameSource,
  QrFrameScheduler,
  SchedulerClock,
} from '../../src/renderer/qr-frame-scheduler';

/* ------------------------------------------------------------------ harness */

/**
 * A clock that only moves when a test says so.
 *
 * A scheduler whose behaviour can only be observed by waiting is a scheduler
 * whose behaviour is never actually asserted; every timing claim below is
 * checked against a clock the test controls rather than against real elapsed
 * time.
 */
class FakeClock implements SchedulerClock {
  current = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimer(delayMs: number, callback: () => void): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { dueAt: this.current + delayMs, callback });
    return handle;
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing timers as they come due and draining microtasks. */
  async advance(ms: number, stepMs = 1): Promise<void> {
    const target = this.current + ms;
    while (this.current < target) {
      this.current = Math.min(target, this.current + stepMs);
      const due = [...this.timers.entries()].filter(([, timer]) => timer.dueAt <= this.current);
      for (const [handle, timer] of due) {
        this.timers.delete(handle);
        timer.callback();
      }
      await flush();
    }
  }
}

/** Drains pending microtasks so awaited work inside the scheduler completes. */
async function flush(): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class CountingSource implements FrameSource {
  requested = 0;
  constructor(private readonly total = Number.POSITIVE_INFINITY, private readonly bytes = 8) {}

  async next(): Promise<Uint8Array | null> {
    if (this.requested >= this.total) return null;
    this.requested += 1;
    return new Uint8Array(this.bytes).fill(this.requested & 0xff);
  }
}

/* -------------------------------------------------------------------- tests */

describe('frames are pulled, never pushed', () => {
  it('asks for nothing until it is started', async () => {
    const clock = new FakeClock();
    const source = new CountingSource();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, source, () => {}, clock);

    await clock.advance(1000);
    expect(source.requested).toBe(0);
    expect(scheduler.stats().framesPainted).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('never holds more frames than its prefetch bound', async () => {
    const clock = new FakeClock();
    const source = new CountingSource();
    const painted: number[] = [];
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      source,
      (frame) => { painted.push(frame[0]); },
      clock,
      { maxPrefetchedFrames: 2 },
    );

    scheduler.start();
    await flush();
    // Two ahead of the painter, and not one more however long nothing consumes.
    expect(source.requested).toBe(2);

    await clock.advance(1000);
    expect(scheduler.stats().queueDepth).toBeLessThanOrEqual(2);
    // Requests track paints plus the bound: there is no path here that
    // pre-generates a transfer.
    expect(source.requested).toBeLessThanOrEqual(painted.length + 2);
    scheduler.stop();
  });

  it('stops asking when the painter stops consuming', async () => {
    const clock = new FakeClock();
    const source = new CountingSource();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, source, () => {}, clock, { maxPrefetchedFrames: 3 });

    scheduler.start();
    await flush();
    scheduler.pause();
    const requestedWhilePaused = source.requested;

    await clock.advance(5000);
    expect(source.requested).toBe(requestedWhilePaused);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('cadence honours the profile', () => {
  it('schedules at the interval the profile implies', () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);
    expect(scheduler.scheduledIntervalMs).toBeCloseTo(1000 / effectiveFps(BALANCED_PROFILE), 6);
  });

  it('lets the frame-hold floor win over a faster target', () => {
    // A camera integrates over an exposure. A frame swapped out sooner than the
    // sensor can gather it is a frame nobody reads, however many the display
    // counts, so the hold is a floor rather than a hint.
    const clock = new FakeClock();
    const greedy = { ...TURBO_PROFILE, targetFps: 60, minFrameHoldMs: 40 };
    const scheduler = new QrFrameScheduler(greedy, new CountingSource(), () => {}, clock);
    expect(scheduler.scheduledIntervalMs).toBe(40);
  });

  it('measures the cadence it actually achieved rather than restating the target', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);

    scheduler.start();
    await clock.advance(1000);
    const stats = scheduler.stats();

    expect(stats.framesPainted).toBeGreaterThan(5);
    // 12 FPS over a second, give or take the frame the window starts on.
    expect(stats.effectiveFps).toBeGreaterThan(effectiveFps(BALANCED_PROFILE) * 0.8);
    expect(stats.effectiveFps).toBeLessThanOrEqual(effectiveFps(BALANCED_PROFILE) * 1.05);
    expect(stats.targetFps).toBeCloseTo(effectiveFps(BALANCED_PROFILE), 6);
    scheduler.stop();
  });

  it('does not fire a burst of catch-up frames after falling behind', async () => {
    // Catching up by rushing trades a late frame for an unreadable one: frames
    // arriving faster than the hold floor are frames no camera reads.
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);

    scheduler.start();
    await clock.advance(100);
    const before = scheduler.stats().framesPainted;

    // A long stall, as though the tab were backgrounded.
    clock.current += 5000;
    await clock.advance(200);

    const gained = scheduler.stats().framesPainted - before;
    expect(gained).toBeLessThanOrEqual(4);
    scheduler.stop();
  });
});

describe('instrumentation reports what happened', () => {
  it('counts paints, paint time and the worst one', async () => {
    const clock = new FakeClock();
    let painted = 0;
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => {
        painted += 1;
        // Charge the clock for the paint, so the timings are not all zero.
        clock.current += painted === 3 ? 30 : 2;
      },
      clock,
    );

    scheduler.start();
    await clock.advance(500);
    const stats = scheduler.stats();

    expect(stats.framesPainted).toBe(painted);
    expect(stats.totalPaintMs).toBeGreaterThan(0);
    expect(stats.maxPaintMs).toBeGreaterThanOrEqual(30);
    expect(stats.elapsedMs).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('counts a paint that outran its slot as an overrun', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => { clock.current += 200; },
      clock,
    );

    scheduler.start();
    await clock.advance(1000);
    expect(scheduler.stats().overruns).toBeGreaterThan(0);
    scheduler.stop();
  });

  it('keeps the schedule running when a paint throws, and counts it', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => {
        attempts += 1;
        if (attempts % 3 === 0) throw new Error('canvas went away');
      },
      clock,
    );

    scheduler.start();
    await clock.advance(1000);
    const stats = scheduler.stats();

    expect(stats.paintFailures).toBeGreaterThan(0);
    // A frame that fails to paint is lost. The schedule is not.
    expect(stats.framesPainted).toBeGreaterThan(stats.paintFailures);
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
  });

  it('reports degraded when the cadence cannot be met', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => { clock.current += 400; },
      clock,
      { healthWindowFrames: 3 },
    );

    scheduler.start();
    await clock.advance(4000);
    expect(scheduler.stats().health).toBe('degraded');
    scheduler.stop();
  });

  it('reports healthy while it is keeping up', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);

    scheduler.start();
    await clock.advance(2000);
    expect(scheduler.stats().health).toBe('healthy');
    scheduler.stop();
  });

  it('finishes rather than spinning when the source runs out', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(5), () => {}, clock);

    scheduler.start();
    await clock.advance(2000);

    expect(scheduler.stats().framesPainted).toBe(5);
    expect(scheduler.stats().health).toBe('finished');
    expect(scheduler.isRunning).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('lifecycle', () => {
  it('cancels its timer on stop and never wakes again', async () => {
    const clock = new FakeClock();
    let painted = 0;
    const scheduler = new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => { painted += 1; },
      clock,
    );

    scheduler.start();
    await clock.advance(300);
    const atStop = painted;

    scheduler.stop();
    // The failure this guards against is a timer that outlives its owner:
    // DESKTOP-CRASH-013 was a main-process interval that kept encoding for a
    // renderer that had already been destroyed.
    expect(clock.pendingTimers).toBe(0);

    await clock.advance(5000);
    expect(painted).toBe(atStop);
    expect(scheduler.isRunning).toBe(false);
  });

  it('is safe to stop twice, and refuses to restart', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);

    scheduler.start();
    await clock.advance(200);
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
    expect(() => scheduler.start()).toThrow(/cannot be restarted/);
    scheduler.resume();
    expect(scheduler.isRunning).toBe(false);
  });

  it('resumes from where it paused, keeping its counters', async () => {
    const clock = new FakeClock();
    const scheduler = new QrFrameScheduler(BALANCED_PROFILE, new CountingSource(), () => {}, clock);

    scheduler.start();
    await clock.advance(500);
    const beforePause = scheduler.stats().framesPainted;
    expect(beforePause).toBeGreaterThan(0);

    scheduler.pause();
    expect(scheduler.stats().health).toBe('idle');
    await clock.advance(2000);
    expect(scheduler.stats().framesPainted).toBe(beforePause);

    scheduler.resume();
    await clock.advance(500);
    expect(scheduler.stats().framesPainted).toBeGreaterThan(beforePause);
    scheduler.stop();
  });

  it('refuses a prefetch bound below one', () => {
    const clock = new FakeClock();
    expect(() => new QrFrameScheduler(
      BALANCED_PROFILE,
      new CountingSource(),
      () => {},
      clock,
      { maxPrefetchedFrames: 0 },
    )).toThrow(/at least 1/);
  });
});
