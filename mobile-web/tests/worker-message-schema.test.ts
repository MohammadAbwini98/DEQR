import { describe, expect, it } from 'vitest';

import {
  MAX_REASON_CHARS,
  RECEIVE_WORKER_PROTOCOL,
  boundReason,
  emptyProgress,
  isReceiveWorkerEvent,
  isReceiveWorkerRequest,
  type ReceiveWorkerEvent,
  type ReceiveWorkerRequest,
} from '../src/worker-protocol';

/**
 * The message schema is the one contract that can be violated by a *different
 * build* of this app.
 *
 * An installed PWA holds its shell in a service-worker cache. That shell can be
 * served against a worker bundle from another release, in either direction, and
 * every field on this wire is read positionally by both sides. So the version
 * stamp is checked before anything else, and both guards refuse rather than
 * coerce.
 */

const limits = {
  maxDecodePixels: 720 * 720,
  dedupeCapacity: 4_096,
  maxActiveSegments: 2,
  segmentBudgetBytes: 1_024,
  storageMarginRatio: 0.15,
};

function pixelFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: RECEIVE_WORKER_PROTOCOL,
    type: 'frame',
    epoch: 1,
    frameId: 9,
    capturedAt: 1_700_000_000_000,
    width: 4,
    height: 4,
    captureScale: 1,
    pixels: new ArrayBuffer(4 * 4 * 4),
    ...overrides,
  };
}

describe('requests are accepted only from a build that speaks this version', () => {
  it('accepts every request this build sends', () => {
    const requests: ReceiveWorkerRequest[] = [
      { v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1, limits },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'verify', epoch: 1 },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1 },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: 1 },
    ];
    for (const request of requests) expect(isReceiveWorkerRequest(request), request.type).toBe(true);
    expect(isReceiveWorkerRequest(pixelFrame())).toBe(true);
  });

  it('refuses another protocol version outright', () => {
    expect(isReceiveWorkerRequest(pixelFrame({ v: RECEIVE_WORKER_PROTOCOL + 1 }))).toBe(false);
    expect(isReceiveWorkerRequest(pixelFrame({ v: undefined }))).toBe(false);
    expect(isReceiveWorkerRequest(pixelFrame({ v: String(RECEIVE_WORKER_PROTOCOL) }))).toBe(false);
  });

  it('refuses anything that is not one of the five request types', () => {
    for (const value of [null, undefined, 42, 'frame', [], { v: RECEIVE_WORKER_PROTOCOL, type: 'evaluate', epoch: 0 }]) {
      expect(isReceiveWorkerRequest(value)).toBe(false);
    }
  });

  it('refuses a frame carrying neither pixels nor a bitmap', () => {
    expect(isReceiveWorkerRequest(pixelFrame({ pixels: undefined }))).toBe(false);
    // A bitmap is checked structurally: `ImageBitmap` is not a global in Node,
    // and a guard that reached for it would refuse every real frame off-device.
    expect(isReceiveWorkerRequest(pixelFrame({ pixels: undefined, bitmap: { width: 4, height: 4 } }))).toBe(true);
  });

  it('refuses a frame whose numbers are not numbers', () => {
    expect(isReceiveWorkerRequest(pixelFrame({ width: -1 }))).toBe(false);
    expect(isReceiveWorkerRequest(pixelFrame({ height: Number.NaN }))).toBe(false);
    expect(isReceiveWorkerRequest(pixelFrame({ epoch: '1' }))).toBe(false);
    expect(isReceiveWorkerRequest(pixelFrame({ captureScale: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('refuses an open whose limits are missing a bound', () => {
    const { maxDecodePixels, ...partial } = limits;
    expect(maxDecodePixels).toBeGreaterThan(0);
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1, limits: partial })).toBe(false);
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1 })).toBe(false);
  });
});

describe('events are accepted only from a build that speaks this version', () => {
  it('accepts every event this build sends', () => {
    const events: ReceiveWorkerEvent[] = [
      { v: RECEIVE_WORKER_PROTOCOL, type: 'ready', acceptsBitmap: true },
      {
        v: RECEIVE_WORKER_PROTOCOL,
        type: 'frame',
        epoch: 1,
        frameId: 1,
        outcome: 'accepted',
        decodeMs: 12,
        pipelineMs: 0.4,
        staleDropped: 0,
      },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: 1, progress: emptyProgress() },
      {
        v: RECEIVE_WORKER_PROTOCOL,
        type: 'verified',
        epoch: 1,
        filename: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 8,
        sha256: new ArrayBuffer(32),
        source: { kind: 'bytes', bytes: new ArrayBuffer(8) },
      },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'failed', epoch: 1, code: 'HASH_MISMATCH', message: 'no' },
      { v: RECEIVE_WORKER_PROTOCOL, type: 'fatal', epoch: 1, code: 'WORKER_ERROR' },
    ];
    for (const event of events) expect(isReceiveWorkerEvent(event), event.type).toBe(true);
  });

  it('refuses a verified event whose payload is not a transferred buffer', () => {
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verified',
      epoch: 1,
      filename: 'a.bin',
      mimeType: '',
      bytes: [1, 2, 3],
      sha256: new ArrayBuffer(32),
    })).toBe(false);
  });

  it('refuses a progress event with no progress in it', () => {
    expect(isReceiveWorkerEvent({ v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: 1 })).toBe(false);
    expect(isReceiveWorkerEvent({ v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: 1, progress: {} })).toBe(false);
  });

  it('requires an epoch on everything except the handshake', () => {
    expect(isReceiveWorkerEvent({ v: RECEIVE_WORKER_PROTOCOL, type: 'ready', acceptsBitmap: false })).toBe(true);
    expect(isReceiveWorkerEvent({ v: RECEIVE_WORKER_PROTOCOL, type: 'fatal', code: 'X' })).toBe(false);
  });
});

describe('a worker-authored message stays bounded', () => {
  it('trims an error longer than the protocol allows', () => {
    const long = 'x'.repeat(MAX_REASON_CHARS * 3);
    expect(boundReason(long).length).toBe(MAX_REASON_CHARS);
    expect(boundReason('short')).toBe('short');
    expect(boundReason('x'.repeat(MAX_REASON_CHARS)).length).toBe(MAX_REASON_CHARS);
  });

  it('reports a progress object with every counter at zero', () => {
    const progress = emptyProgress();
    expect(progress.unitsRecovered).toBe(0);
    expect(progress.sessionActive).toBe(false);
    expect(progress.storagePressure).toBe(false);
    expect(progress.storageKind).toBe('none');
    expect(progress.heldBytes).toBe(0);
    expect(progress.fault).toBeUndefined();
    // A session that has adopted nothing says so, rather than leaving a field
    // undefined that a screen would have to treat as a third state.
    expect(progress.unitsAdopted).toBe(0);
    expect(progress.resumed).toBe(false);
    expect(progress.resumeToken).toBeUndefined();
    expect(progress.checkpointRejection).toBeUndefined();
  });
});

describe('the session-ending reason crosses the wire or does not cross at all', () => {
  it('accepts the four reasons this build knows', () => {
    for (const reason of ['cancelled', 'failed', 'interrupted', 'completed'] as const) {
      expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1, reason })).toBe(true);
      expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: 1, reason })).toBe(true);
    }
  });

  it('accepts a close with no reason at all, which discards', () => {
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1 })).toBe(true);
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'close', epoch: 1 })).toBe(true);
  });

  it('refuses a reason it does not know rather than defaulting one', () => {
    // Guessing here would mean guessing whether to delete somebody's partial
    // transfer, so an unrecognised reason is a refused message.
    for (const reason of ['paused', '', 'CANCELLED', 42, null]) {
      expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'reset', epoch: 1, reason })).toBe(false);
    }
  });

  it('accepts an open with or without a resume flag, and refuses a non-boolean one', () => {
    expect(isReceiveWorkerRequest({ v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1, limits })).toBe(true);
    expect(isReceiveWorkerRequest({
      v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1, limits, resume: true,
    })).toBe(true);
    expect(isReceiveWorkerRequest({
      v: RECEIVE_WORKER_PROTOCOL, type: 'open', epoch: 1, limits, resume: 'yes',
    })).toBe(false);
  });
});

describe('verification progress is its own event', () => {
  it('accepts one carrying both counters and a phase', () => {
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verify-progress',
      epoch: 1,
      bytesHashed: 0,
      bytesTotal: 1_048_576,
      phase: 'hashing',
    })).toBe(true);
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL,
      type: 'verify-progress',
      epoch: 1,
      bytesHashed: 0,
      bytesTotal: 1_048_576,
      phase: 'decompressing',
    })).toBe(true);
  });

  it('refuses an unnamed or unknown phase', () => {
    // A bar that cannot tell decompression from hashing would restart at zero
    // half way through a compressed transfer and read as a stall, so the phase
    // is required rather than defaulted.
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL, type: 'verify-progress', epoch: 1, bytesHashed: 0, bytesTotal: 10,
    })).toBe(false);
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL, type: 'verify-progress', epoch: 1, bytesHashed: 0, bytesTotal: 10, phase: 'verifying',
    })).toBe(false);
  });

  it('refuses one missing a counter, or carrying a negative one', () => {
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL, type: 'verify-progress', epoch: 1, bytesTotal: 10, phase: 'hashing',
    })).toBe(false);
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL, type: 'verify-progress', epoch: 1, bytesHashed: -1, bytesTotal: 10, phase: 'hashing',
    })).toBe(false);
  });

  it('is refused by a build that speaks an older protocol', () => {
    // The point of the version bump. A Phase 06 shell against a Phase 07 worker
    // fails at the handshake rather than silently ignoring a new event type.
    expect(isReceiveWorkerEvent({
      v: RECEIVE_WORKER_PROTOCOL - 1,
      type: 'verify-progress',
      epoch: 1,
      bytesHashed: 0,
      bytesTotal: 1,
    })).toBe(false);
  });
});
