import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CameraController, type CaptureTarget } from '../src/camera';

describe('CameraController terminal scheduling', () => {
  let scheduled: Array<() => void>;
  let setTimeoutMock: ReturnType<typeof vi.fn>;
  let clearTimeoutMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scheduled = [];
    setTimeoutMock = vi.fn((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length;
    });
    clearTimeoutMock = vi.fn();
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('window', {
      setTimeout: setTimeoutMock,
      clearTimeout: clearTimeoutMock,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops the stream and prevents an already queued camera callback from capturing', async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const video = {
      srcObject: null,
      pause: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    const canvas = {} as HTMLCanvasElement;
    const submit = vi.fn().mockReturnValue(true);
    const target: CaptureTarget = { canAccept: () => true, submit, supportsBitmapTransfer: false };
    const controller = new CameraController(video, canvas, target, vi.fn());

    await expect(controller.start()).resolves.toBe(true);
    expect(setTimeoutMock).toHaveBeenCalledOnce();

    controller.stop();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(clearTimeoutMock).toHaveBeenCalledWith(1);
    scheduled[0]();

    expect(submit).not.toHaveBeenCalled();
    expect(setTimeoutMock).toHaveBeenCalledOnce();
    controller.dispose();
  });
});
