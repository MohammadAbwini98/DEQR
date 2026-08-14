import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/decoder', () => ({
  RawQrDecoder: class RawQrDecoder {
    decode(): Promise<{ elapsedMs: number }> {
      return Promise.resolve({ elapsedMs: 0 });
    }

    dispose(): void {}
  },
}));

import { CameraController } from '../src/camera';

/**
 * The scan loop has to keep itself alive.
 *
 * `requestVideoFrameCallback` fires only when the element presents a frame, so
 * a loop built on it alone is not a loop: if iOS never starts presenting, or
 * the stream stalls across a lifecycle transition, nothing ever fires again and
 * scanning stops permanently while the preview still reports an active camera.
 */
describe('CameraController scan loop resilience', () => {
  let timers: Array<{ id: number; fn: () => void; ms: number; cancelled: boolean }>;
  let nextTimer: number;
  let hidden: boolean;

  const runDueTimers = async () => {
    // Only fire what is armed right now, so a callback that re-arms does not
    // recurse forever inside one flush.
    const due = timers.filter((t) => !t.cancelled);
    timers = [];
    for (const timer of due) timer.fn();
    // `capture` is async and re-arms from a `.finally`, so the next wake-up
    // exists only after the microtask queue drains.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    timers = [];
    nextTimer = 1;
    hidden = false;
    vi.stubGlobal('document', { get hidden() { return hidden; } });
    vi.stubGlobal('performance', { now: () => 0 });
    // A browser global the capture path reads for its readyState comparison.
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.push({ id, fn, ms, cancelled: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const found = timers.find((t) => t.id === id);
        if (found) found.cancelled = true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function videoStub(withRvfc: boolean) {
    const rvfc: Array<(now: number) => void> = [];
    const video = {
      srcObject: null as unknown,
      readyState: 0,
      videoWidth: 0,
      videoHeight: 0,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      ...(withRvfc
        ? {
            requestVideoFrameCallback: vi.fn((cb: (now: number) => void) => { rvfc.push(cb); return rvfc.length; }),
            cancelVideoFrameCallback: vi.fn(),
          }
        : {}),
    } as unknown as HTMLVideoElement;
    return { video, rvfc };
  }

  const start = async (video: HTMLVideoElement) => {
    const stopTrack = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) },
    });
    const onBytes = vi.fn();
    const controller = new CameraController(video, {} as HTMLCanvasElement, onBytes, vi.fn());
    await expect(controller.start()).resolves.toBe(true);
    return { controller, onBytes, stopTrack };
  };

  it('keeps scanning when the video never presents a frame', async () => {
    const { video } = videoStub(true);
    const { controller } = await start(video);

    // rVFC armed, and a watchdog armed beside it.
    expect((video as unknown as { requestVideoFrameCallback: unknown }).requestVideoFrameCallback).toHaveBeenCalled();
    expect(timers.some((t) => !t.cancelled), 'a fallback wake-up must be armed').toBe(true);

    // The camera never presents anything; only the watchdog can advance.
    for (let i = 0; i < 3; i++) {
      expect(timers.some((t) => !t.cancelled), `loop died on iteration ${i}`).toBe(true);
      await runDueTimers();
    }

    controller.dispose();
  });

  it('resumes after the page is hidden and shown again', async () => {
    const { video } = videoStub(false);
    const { controller } = await start(video);

    hidden = true;
    await runDueTimers();
    // Being backgrounded must not consume the last wake-up.
    expect(timers.some((t) => !t.cancelled), 'no wake-up survived backgrounding').toBe(true);

    hidden = false;
    await runDueTimers();
    expect(timers.some((t) => !t.cancelled), 'loop did not resume on return').toBe(true);

    controller.dispose();
  });

  it('runs on a plain timer when the browser has no frame callback', async () => {
    const { video } = videoStub(false);
    const { controller } = await start(video);

    for (let i = 0; i < 3; i++) {
      expect(timers.some((t) => !t.cancelled), `loop died on iteration ${i}`).toBe(true);
      await runDueTimers();
    }

    controller.dispose();
  });

  it('stops every wake-up when the controller is stopped', async () => {
    const { video, rvfc } = videoStub(true);
    const { controller, stopTrack } = await start(video);

    controller.stop();

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(timers.every((t) => t.cancelled), 'a timer outlived stop()').toBe(true);
    expect((video as unknown as { cancelVideoFrameCallback: ReturnType<typeof vi.fn> }).cancelVideoFrameCallback)
      .toHaveBeenCalled();

    // A frame callback that was already queued must not restart the loop.
    rvfc.forEach((cb) => cb(0));
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  it('ignores a stale callback from a previous stream', async () => {
    const { video, rvfc } = videoStub(true);
    const { controller, onBytes } = await start(video);

    const stale = rvfc[0];
    controller.stop();
    timers = [];

    // The old generation must not schedule anything or read pixels.
    stale(0);
    expect(timers.length, 'a stale callback re-armed the loop').toBe(0);
    expect(onBytes).not.toHaveBeenCalled();

    controller.dispose();
  });
});

