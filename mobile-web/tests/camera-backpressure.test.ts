import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CameraController, activeCameraCount, type CaptureTarget } from '../src/camera';
import { TelemetryCollector } from '../src/metrics';

/**
 * What the camera does when the decoder cannot keep up, and when the hardware
 * is taken away from it.
 *
 * The first is the phase's central claim. At the Phase 04 profile cadences the
 * decoder is saturated most of the time, so "the pipeline is busy" is the
 * normal case rather than the exceptional one, and what the loop spends in that
 * state is what decides whether sustained scanning stays bounded. The answer
 * here is: a timer, and nothing else - no `drawImage`, no `getImageData`, no
 * `createImageBitmap`, no `postMessage`.
 */

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

describe('the capture loop spends nothing while the pipeline is saturated', () => {
  let timers: Timer[];
  let nextTimer: number;
  let nowMs: number;

  /**
   * Fires everything armed and advances the clock past any capture interval.
   *
   * The loop re-arms in two steps - a wake-up that calls `schedule`, and the
   * `schedule` that arms the step - so one call here is not one iteration.
   */
  const runDueTimers = async () => {
    nowMs += 50;
    const due = timers.filter((timer) => !timer.cancelled);
    timers = [];
    for (const timer of due) timer.fn();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    timers = [];
    nextTimer = 1;
    nowMs = 0;
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('performance', { now: () => nowMs });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('window', {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextTimer++;
        timers.push({ id, fn, ms, cancelled: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const found = timers.find((timer) => timer.id === id);
        if (found) found.cancelled = true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function videoStub() {
    return {
      srcObject: null as unknown,
      readyState: 2,
      videoWidth: 1280,
      videoHeight: 720,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
  }

  function canvasStub() {
    const getImageData = vi.fn(() => ({
      data: new Uint8ClampedArray(619 * 619 * 4),
      width: 619,
      height: 619,
    }));
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage, getImageData })),
    } as unknown as HTMLCanvasElement;
    return { canvas, drawImage, getImageData };
  }

  function stubMedia() {
    const stopTrack = vi.fn();
    const track = { stop: stopTrack, onended: null as null | (() => void) };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
    });
    return { stopTrack, track };
  }

  it('reads no pixels and posts nothing while the target is busy', async () => {
    stubMedia();
    const video = videoStub();
    const { canvas, drawImage, getImageData } = canvasStub();
    const submit = vi.fn().mockReturnValue(true);
    const target: CaptureTarget = { canAccept: () => false, submit, supportsBitmapTransfer: false };
    const telemetry = new TelemetryCollector();

    const controller = new CameraController(video, canvas, target, vi.fn(), telemetry);
    await expect(controller.start()).resolves.toBe(true);

    for (let iteration = 0; iteration < 12; iteration += 1) await runDueTimers();

    expect(drawImage, 'the loop drew a frame nobody could decode').not.toHaveBeenCalled();
    expect(getImageData, 'the loop copied 1.5 MB nobody could decode').not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // The loop is still alive; it is waiting, not dead.
    expect(timers.some((timer) => !timer.cancelled)).toBe(true);
    expect(telemetry.snapshot(0, 0, 2, false).skippedBusy).toBeGreaterThan(0);

    controller.dispose();
  });

  it('captures again the moment the target has room', async () => {
    stubMedia();
    const video = videoStub();
    const { canvas, getImageData } = canvasStub();
    let ready = false;
    const submit = vi.fn().mockReturnValue(true);
    const target: CaptureTarget = { canAccept: () => ready, submit, supportsBitmapTransfer: false };

    const controller = new CameraController(video, canvas, target, vi.fn());
    await expect(controller.start()).resolves.toBe(true);

    await runDueTimers();
    expect(submit).not.toHaveBeenCalled();

    ready = true;
    // One wake-up re-arms `schedule`, the next arms the step that captures.
    await runDueTimers();
    await runDueTimers();
    expect(getImageData).toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();

    const frame = submit.mock.calls[0][0];
    // Transferred, not cloned: the ROI is 1.5 MB and copying it per frame is
    // the main-thread cost this path exists to avoid.
    expect(frame.pixels).toBeInstanceOf(ArrayBuffer);
    expect(frame.width).toBe(619);
    expect(frame.captureScale).toBe(1);

    controller.dispose();
  });

  it('does not leak a frame the target refused after it was made', async () => {
    stubMedia();
    const video = videoStub();
    const { canvas } = canvasStub();
    // `canAccept` says yes and `submit` then says no - the race between the
    // gate and the post. The frame must be dropped, not retried or queued.
    const submit = vi.fn().mockReturnValue(false);
    const target: CaptureTarget = { canAccept: () => true, submit, supportsBitmapTransfer: false };

    const controller = new CameraController(video, canvas, target, vi.fn());
    await expect(controller.start()).resolves.toBe(true);
    await runDueTimers();
    await runDueTimers();

    expect(submit).toHaveBeenCalled();
    expect(timers.some((timer) => !timer.cancelled), 'the loop stopped on a refused frame').toBe(true);
    controller.dispose();
  });

  it('falls back to the canvas path for good once a bitmap capture fails', async () => {
    stubMedia();
    const video = videoStub();
    const { canvas, getImageData } = canvasStub();
    const createImageBitmap = vi.fn().mockRejectedValue(new Error('unsupported overload'));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const submit = vi.fn().mockReturnValue(true);
    const target: CaptureTarget = { canAccept: () => true, submit, supportsBitmapTransfer: true };

    const controller = new CameraController(video, canvas, target, vi.fn());
    await expect(controller.start()).resolves.toBe(true);

    await runDueTimers();
    await runDueTimers();

    // Safari has shipped `createImageBitmap` both with and without the crop and
    // resize overloads. One rejection is enough to know; retrying per frame
    // would cost a promise and a throw at the camera's rate all session.
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(getImageData).toHaveBeenCalled();
    controller.dispose();
  });
});

describe('the camera lifecycle is explicit about how it went wrong', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('performance', { now: () => 0 });
    vi.stubGlobal('window', { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const target: CaptureTarget = { canAccept: () => true, submit: () => true, supportsBitmapTransfer: false };

  function failingCamera(name: string) {
    const error = Object.assign(new Error(name), { name });
    Object.setPrototypeOf(error, DOMException.prototype);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(error) },
    });
  }

  it.each([
    ['NotAllowedError', 'CAMERA_PERMISSION_DENIED'],
    ['NotFoundError', 'CAMERA_UNAVAILABLE'],
    // The one worth separating: the camera exists and is permitted, but another
    // app has it. Sending that person to the permission screen sends them
    // somewhere nothing is wrong.
    ['NotReadableError', 'CAMERA_BUSY'],
    ['OverconstrainedError', 'CAMERA_UNAVAILABLE'],
    ['TypeError', 'CAMERA_STREAM_FAILED'],
  ])('maps %s onto %s', async (domName, expected) => {
    failingCamera(domName);
    const onError = vi.fn();
    const video = { srcObject: null, pause: vi.fn(), play: vi.fn() } as unknown as HTMLVideoElement;
    const controller = new CameraController(video, {} as HTMLCanvasElement, target, onError);

    await expect(controller.start()).rejects.toBeDefined();
    expect(onError).toHaveBeenCalledWith(expected);
    controller.dispose();
  });

  it('reports a track that ends under it as an interruption', async () => {
    const track: { stop: () => void; onended: null | (() => void) } = { stop: vi.fn(), onended: null };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) },
    });
    const onError = vi.fn();
    const video = {
      srcObject: null,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    const controller = new CameraController(video, {} as HTMLCanvasElement, target, onError);
    await expect(controller.start()).resolves.toBe(true);

    // A phone call, or another app taking the camera. Without this it looks
    // exactly like a camera pointed at a blank wall.
    expect(track.onended).toBeTypeOf('function');
    track.onended!();
    expect(onError).toHaveBeenCalledWith('CAMERA_INTERRUPTED');
    expect(activeCameraCount()).toBe(0);
  });

  it('never lets two controllers hold a stream at once', async () => {
    const stops: string[] = [];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockImplementation(() => Promise.resolve({
          getTracks: () => [{ stop: () => stops.push('stopped'), onended: null }],
        })),
      },
    });
    const video = () => ({
      srcObject: null,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement);

    const first = new CameraController(video(), {} as HTMLCanvasElement, target, vi.fn());
    await first.start();
    expect(activeCameraCount()).toBe(1);

    // A React effect that runs twice, or a retry that builds a second
    // controller before the first let go. iOS answers the second request by
    // taking the stream from the first, which surfaces as a frozen preview.
    const second = new CameraController(video(), {} as HTMLCanvasElement, target, vi.fn());
    await second.start();

    expect(stops.length, 'the first controller kept its stream').toBeGreaterThanOrEqual(1);
    expect(activeCameraCount()).toBe(1);

    second.dispose();
    first.dispose();
    expect(activeCameraCount()).toBe(0);
  });
});
