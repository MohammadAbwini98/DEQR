import { describe, expect, it, vi } from 'vitest';

import { TelemetryCollector } from '../src/metrics';
import {
  ReceiverClient,
  type CapturedFrame,
  type ReceiverClientCallbacks,
  type WorkerLike,
} from '../src/receiver-client';
import {
  FRAME_OUTCOME,
  RECEIVE_WORKER_PROTOCOL,
  emptyProgress,
  type FrameOutcome,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
} from '../src/worker-protocol';

/**
 * The in-flight cap is this phase's queue bound, so this suite is where it is
 * held.
 *
 * The property under test is narrow and load-bearing: **a frame that goes out
 * always comes back**. Capture asks `canAccept()` before spending anything, so
 * a slot that is never returned does not merely lose a frame - it permanently
 * lowers the ceiling, and enough of them stop the camera altogether. A bound
 * that silently becomes a deadlock is worse than no bound.
 */

class FakeWorker implements WorkerLike {
  readonly sent: ReceiveWorkerRequest[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = 0;
  refusePosts = false;

  postMessage(message: unknown): void {
    if (this.refusePosts) throw new Error('worker is gone');
    this.sent.push(message as ReceiveWorkerRequest);
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Delivers an event as the real worker would. */
  emit(event: ReceiveWorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }

  answer(frameId: number, epoch: number, outcome: FrameOutcome = FRAME_OUTCOME.ACCEPTED): void {
    this.emit({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch,
      frameId,
      outcome,
      decodeMs: 70,
      pipelineMs: 0.3,
      staleDropped: 0,
    });
  }

  frames(): Array<Extract<ReceiveWorkerRequest, { type: 'frame' }>> {
    return this.sent.filter((request): request is Extract<ReceiveWorkerRequest, { type: 'frame' }> => request.type === 'frame');
  }
}

function harness(options: { maxInFlight?: number } = {}) {
  const worker = new FakeWorker();
  const callbacks: ReceiverClientCallbacks = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onVerified: vi.fn(),
    onFailed: vi.fn(),
    onFatal: vi.fn(),
  };
  const telemetry = new TelemetryCollector();
  const client = new ReceiverClient(callbacks, {
    createWorker: () => worker,
    telemetry,
    maxInFlight: options.maxInFlight ?? 2,
    now: () => 0,
  });
  return { worker, callbacks, telemetry, client };
}

let nextFrameId = 0;
function frame(): CapturedFrame {
  return {
    frameId: ++nextFrameId,
    capturedAt: 1_700_000_000_000,
    width: 8,
    height: 8,
    captureScale: 1,
    pixels: new ArrayBuffer(8 * 8 * 4),
  };
}

describe('the client never has more frames outstanding than its cap', () => {
  it('refuses a frame past the cap and takes one again as answers arrive', () => {
    const { worker, client } = harness({ maxInFlight: 2 });
    const epoch = client.open();

    const first = frame();
    const second = frame();
    expect(client.submit(first)).toBe(true);
    expect(client.submit(second)).toBe(true);
    expect(client.canAccept(), 'the cap did not close').toBe(false);
    expect(client.submit(frame()), 'a frame got past the cap').toBe(false);
    expect(worker.frames()).toHaveLength(2);

    worker.answer(first.frameId, epoch);
    expect(client.canAccept()).toBe(true);
    expect(client.framesInFlight).toBe(1);
  });

  it('stays bounded across a long run whatever order the answers come back in', () => {
    const { worker, client } = harness({ maxInFlight: 2 });
    const epoch = client.open();
    const outstanding: number[] = [];
    let peak = 0;
    let submitted = 0;

    // 500 capture attempts against a decoder that answers late and out of
    // order. This is the shape of a sustained scan, and the only thing that
    // must hold is that the outstanding set never exceeds the cap.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (client.canAccept()) {
        const next = frame();
        client.submit(next);
        outstanding.push(next.frameId);
        submitted += 1;
      }
      peak = Math.max(peak, client.framesInFlight);
      if (outstanding.length && attempt % 3 === 0) {
        const index = attempt % outstanding.length;
        worker.answer(outstanding.splice(index, 1)[0], epoch);
      }
    }

    expect(peak).toBe(2);
    expect(submitted).toBeGreaterThan(100);
    expect(client.framesInFlight).toBeLessThanOrEqual(2);
  });

  it('gives the slot back for a frame the worker refused as stale', () => {
    const { worker, client } = harness({ maxInFlight: 1 });
    const epoch = client.open();
    const only = frame();
    client.submit(only);
    expect(client.canAccept()).toBe(false);

    // A stale answer is still an answer. If it were not, the cap would ratchet
    // down by one every time the worker skipped a frame.
    worker.answer(only.frameId, epoch, FRAME_OUTCOME.STALE);
    expect(client.canAccept()).toBe(true);
  });

  it('releases every slot when a session ends mid-decode', () => {
    const { client } = harness({ maxInFlight: 2 });
    client.open();
    client.submit(frame());
    client.submit(frame());
    expect(client.framesInFlight).toBe(2);

    // Cancel. The two frames are still inside the worker and their answers will
    // arrive for a session that no longer exists.
    client.close();
    const nextEpoch = client.open();
    expect(client.framesInFlight).toBe(0);
    expect(client.canAccept()).toBe(true);
    expect(nextEpoch).toBeGreaterThan(0);
  });

  it('refuses everything before a session is opened and after disposal', () => {
    const { client } = harness();
    expect(client.canAccept()).toBe(false);
    expect(client.submit(frame())).toBe(false);

    client.open();
    expect(client.canAccept()).toBe(true);
    client.dispose();
    expect(client.canAccept()).toBe(false);
    expect(client.submit(frame())).toBe(false);
  });
});

describe('an event from a session that has ended changes nothing', () => {
  it('discards progress, verified files and failures from an older epoch', () => {
    const { worker, callbacks, client } = harness();
    const stale = client.open();
    client.close();
    client.open();

    worker.emit({ v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: stale, progress: emptyProgress() });
    worker.emit({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verified',
      epoch: stale,
      filename: 'cancelled.bin',
      mimeType: '',
      size: 4,
      sha256: new ArrayBuffer(32),
      source: { kind: 'bytes', bytes: new ArrayBuffer(4) },
    });
    worker.emit({ v: RECEIVE_WORKER_PROTOCOL, type: 'failed', epoch: stale, code: 'X', message: 'y' });

    // A verified file for a cancelled transfer is the one that matters: it
    // would be offered to the share sheet for a session the user stopped.
    expect(callbacks.onVerified).not.toHaveBeenCalled();
    expect(callbacks.onProgress).not.toHaveBeenCalled();
    expect(callbacks.onFailed).not.toHaveBeenCalled();
  });

  it('ignores a message from a build that speaks another protocol version', () => {
    const { worker, callbacks, client } = harness();
    const epoch = client.open();
    worker.emit({ v: RECEIVE_WORKER_PROTOCOL + 1, type: 'progress', epoch, progress: emptyProgress() } as ReceiveWorkerEvent);
    expect(callbacks.onProgress).not.toHaveBeenCalled();
  });

  it('hands over a verified file for the live session', () => {
    const { worker, callbacks, client } = harness();
    const epoch = client.open();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    worker.emit({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verified',
      epoch,
      filename: 'ok.bin',
      mimeType: 'application/octet-stream',
      size: 4,
      sha256: new ArrayBuffer(32),
      source: { kind: 'bytes', bytes },
    });
    expect(callbacks.onVerified).toHaveBeenCalledWith(expect.objectContaining({ filename: 'ok.bin' }));
  });
});

describe('a worker that dies is reported, not waited on', () => {
  it('raises a scanner fault and frees the camera to be stopped', () => {
    const { worker, callbacks, client } = harness();
    client.open();
    client.submit(frame());

    worker.onerror?.({});

    expect(callbacks.onFatal).toHaveBeenCalledWith('SCANNER_UNAVAILABLE');
    expect(worker.terminated).toBe(1);
    // Not merely "no longer accepting": the slots are released too, so a retry
    // starts from a full budget rather than from a permanently reduced one.
    expect(client.framesInFlight).toBe(0);
    expect(client.canAccept()).toBe(false);
  });

  it('treats a fatal message the same as a dead worker', () => {
    const { worker, callbacks, client } = harness();
    const epoch = client.open();
    worker.emit({ v: RECEIVE_WORKER_PROTOCOL, type: 'fatal', epoch, code: 'WORKER_ERROR' });
    expect(callbacks.onFatal).toHaveBeenCalledWith('WORKER_ERROR');
  });

  it('does not strand a slot when the post itself is refused', () => {
    const { worker, callbacks, client } = harness();
    client.open();
    worker.refusePosts = true;

    // The buffer is already detached by the time `postMessage` throws, so the
    // frame is gone either way. What must not happen is the slot going with it.
    client.submit(frame());
    expect(client.framesInFlight).toBe(0);
    expect(callbacks.onFatal).toHaveBeenCalled();
  });
});

describe('telemetry follows the frames', () => {
  it('separates decoded, unique and duplicate frames', () => {
    const { worker, telemetry, client } = harness({ maxInFlight: 4 });
    const epoch = client.open();
    const ids = [frame(), frame(), frame(), frame()];
    for (const one of ids) client.submit(one);

    worker.answer(ids[0].frameId, epoch, FRAME_OUTCOME.ACCEPTED);
    worker.answer(ids[1].frameId, epoch, FRAME_OUTCOME.DUPLICATE);
    worker.answer(ids[2].frameId, epoch, FRAME_OUTCOME.NO_CODE);
    worker.answer(ids[3].frameId, epoch, FRAME_OUTCOME.STALE);

    const snapshot = telemetry.snapshot(0, client.framesInFlight, client.maxInFlight, false);
    // A frame with no code in it is a capture, not a decode, and a stale frame
    // is neither. Counting either as a decode would make the duplicate ratio -
    // the number that says whether the receiver is keeping up - meaningless.
    expect(snapshot.decodedFrames).toBe(2);
    expect(snapshot.duplicateRatio).toBeCloseTo(0.5, 6);
    expect(snapshot.decodeP50Ms).toBe(70);
  });

  it('records the optical observation from whichever frame carried one', () => {
    const { worker, telemetry, client } = harness();
    const epoch = client.open();
    const one = frame();
    client.submit(one);
    worker.emit({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'frame',
      epoch,
      frameId: one.frameId,
      outcome: FRAME_OUTCOME.ACCEPTED,
      decodeMs: 64,
      pipelineMs: 0.2,
      staleDropped: 3,
      observed: {
        qrVersion: 18,
        modulesPerSide: 89,
        symbolSpanPx: 356,
        pxPerModule: 4,
        spanSkew: 0.98,
        captureEdgePx: 620,
        captureScale: 1,
      },
    });

    const snapshot = telemetry.snapshot(0, 0, 2, true);
    expect(snapshot.optical?.pxPerModule).toBe(4);
    expect(snapshot.droppedStale).toBe(3);
    expect(snapshot.zeroCopyCapture).toBe(true);
  });
});
