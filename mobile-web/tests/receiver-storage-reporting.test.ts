import { describe, expect, it } from 'vitest';
import {
  ReceiverStorage,
  discardRetainedSessions,
  estimateDeviceStorage,
} from '../src/receiver-storage';
import {
  OPFS_ROOT_DIR,
  OPFS_SESSIONS_DIR,
  sessionDirectoryName,
  type StorageEnvironment,
} from '../src/opfs';
import {
  RECEIVE_WORKER_PROTOCOL,
  emptyProgress,
  isReceiveWorkerEvent,
  type ReceiveProgress,
} from '../src/worker-protocol';
import {
  V2_COMPRESSION,
  V2_FEC_PROFILE,
  planSegmentation,
  type DeqrV2Manifest,
} from '../../src/core/protocol-v2';
import { sha256Bytes } from '../../src/core/sha256-stream';
import { fakeEnvironment } from './helpers/fake-opfs';

/** A manifest the real store can actually open against. */
function manifestFor(transportSize: number): { manifest: DeqrV2Manifest; plan: ReturnType<typeof planSegmentation> } {
  const segmentSizeBytes = 65_536;
  const symbolSizeBytes = 512;
  const plan = planSegmentation({ transportSize: BigInt(transportSize), segmentSizeBytes, symbolSizeBytes });
  return {
    plan,
    manifest: {
      featureFlags: 0,
      sessionId: 0x5eed_0009,
      fileId: 0x0a0b_0c0d,
      originalSize: BigInt(transportSize),
      transportSize: BigInt(transportSize),
      segmentSizeBytes,
      symbolSizeBytes,
      segmentCount: plan.segmentCount,
      fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 0,
      transportProfileId: 0,
      sha256: sha256Bytes(new Uint8Array(8)),
      filename: 'phase09.bin',
      mimeType: 'application/octet-stream',
    },
  };
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function environmentOf(options: Parameters<typeof fakeEnvironment>[0] = {}): StorageEnvironment {
  return fakeEnvironment(options).environment as unknown as StorageEnvironment;
}

describe('device storage estimate', () => {
  it('reports what the browser says is left', async () => {
    const environment = environmentOf({ quotaBytes: 8 * GIB });
    const estimate = await estimateDeviceStorage(environment);
    expect(estimate.measured).toBe(true);
    expect(estimate.availableBytes).toBe(8 * GIB);
  });

  it('reports no measurement rather than zero room when there is no estimate API', async () => {
    const environment = environmentOf({ withoutEstimate: true });
    const estimate = await estimateDeviceStorage(environment);
    // The distinction the home screen depends on: a browser that will not
    // answer must not be rendered as a device with nothing left, and must not
    // be rendered as a device with plenty either.
    expect(estimate.measured).toBe(false);
    expect(estimate.availableBytes).toBe(0);
  });

  it('survives an estimate that throws', async () => {
    const environment: StorageEnvironment = {
      storage: {
        estimate: async () => { throw new Error('denied'); },
      } as unknown as StorageEnvironment['storage'],
      supportsSyncAccess: false,
    };
    await expect(estimateDeviceStorage(environment)).resolves.toEqual({
      availableBytes: 0,
      measured: false,
    });
  });
});

describe('discarding retained sessions', () => {
  async function seedSessions(environment: StorageEnvironment, names: string[]): Promise<void> {
    const root = await environment.storage!.getDirectory!();
    const deqr = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
    const sessions = await deqr.getDirectoryHandle(OPFS_SESSIONS_DIR, { create: true });
    for (const name of names) await sessions.getDirectoryHandle(name, { create: true });
  }

  it('removes every partly-received transfer this origin is holding', async () => {
    const { storage, environment } = fakeEnvironment();
    const typed = environment as unknown as StorageEnvironment;
    const names = [
      sessionDirectoryName(1, 1),
      sessionDirectoryName(0x5eed_0002, 0x0a0b_0c0d),
      sessionDirectoryName(0xffff_ffff, 0),
    ];
    await seedSessions(typed, names);
    expect(storage.sessionNames()).toEqual([...names].sort());

    const removed = await discardRetainedSessions(typed);
    expect([...removed].sort()).toEqual([...names].sort());
    // The data lives in origin-private storage, which the Files app cannot
    // reach. If this leaves anything, the user has no other way to reclaim it.
    expect(storage.sessionNames()).toEqual([]);
  });

  it('is a no-op, not an error, when there is nothing to discard', async () => {
    const { environment } = fakeEnvironment();
    await expect(discardRetainedSessions(environment as unknown as StorageEnvironment)).resolves.toEqual([]);
  });

  it('leaves a directory this receiver did not create', async () => {
    const { storage, environment } = fakeEnvironment();
    const typed = environment as unknown as StorageEnvironment;
    await seedSessions(typed, ['not-a-session', sessionDirectoryName(7, 7)]);

    const removed = await discardRetainedSessions(typed);
    // Session names are fixed-width hex by construction, and the listing
    // refuses anything else. A discard is still a deletion, and it may only
    // ever reach paths this receiver itself produced.
    expect(removed).toEqual([sessionDirectoryName(7, 7)]);
    // The foreign directory is still there, untouched. `sessionNames()` on the
    // fake reports whatever is on disk, unfiltered, which is what makes this
    // assertion about the discard rather than about the listing.
    expect(storage.sessionNames()).toEqual(['not-a-session']);
  });

  it('reports nothing rather than throwing on a browser without OPFS', async () => {
    const environment: StorageEnvironment = { storage: undefined, supportsSyncAccess: false };
    await expect(discardRetainedSessions(environment)).resolves.toEqual([]);
  });
});

describe('the storage preflight reaches a screen', () => {
  it('returns the figures behind a refusal, not only the code', async () => {
    // A device with far less room than the transfer needs.
    const environment = environmentOf({ quotaBytes: 64 * MIB });
    const storage = new ReceiverStorage({ environment, allowMemoryFallback: false });
    const { manifest, plan } = manifestFor(4 * GIB);

    const provision = await storage.provision(manifest, plan, 'big.bin');
    expect(provision.ok).toBe(false);
    if (provision.ok) return;
    expect(provision.code).toBe('INSUFFICIENT_STORAGE');
    // The whole point of Phase 09's plumbing: a refusal that can say how much
    // room it wanted and how much it thought was there.
    expect(provision.preflight).toBeDefined();
    expect(provision.preflight!.requiredBytes).toBeGreaterThan(4 * GIB);
    expect(provision.preflight!.availableBytes).toBeLessThan(64 * MIB + 1);
    expect(provision.preflight!.confidence).toBe('reported');
  });

  it('marks the answer unknown when the browser has no estimate API', async () => {
    const environment = environmentOf({ withoutEstimate: true });
    const storage = new ReceiverStorage({ environment });
    const { manifest, plan } = manifestFor(2 * MIB);

    const provision = await storage.provision(manifest, plan, 'small.bin');
    expect(provision.ok).toBe(true);
    if (!provision.ok) return;
    // Started, not refused - but the confidence says the check did not happen.
    expect(provision.preflight?.confidence).toBe('unknown');
    expect(provision.preflight?.availableBytes).toBeUndefined();
    await provision.store.dispose('discard');
  });
});

describe('the progress message carries the storage decision', () => {
  function progressEvent(progress: ReceiveProgress) {
    return { v: RECEIVE_WORKER_PROTOCOL, type: 'progress', epoch: 1, progress };
  }

  it('starts with no claim at all', () => {
    const empty = emptyProgress();
    expect(empty.storageConfidence).toBe('none');
    expect(empty.storageRequiredBytes).toBe(0);
    expect(empty.storageAvailableBytes).toBe(0);
    expect(isReceiveWorkerEvent(progressEvent(empty))).toBe(true);
  });

  it('accepts every confidence the preflight can produce', () => {
    for (const storageConfidence of ['none', 'reported', 'unknown'] as const) {
      expect(
        isReceiveWorkerEvent(progressEvent({ ...emptyProgress(), storageConfidence })),
        storageConfidence,
      ).toBe(true);
    }
  });

  it('refuses a malformed storage summary rather than rendering it', () => {
    // The summary is the one thing on the receive screen that tells someone
    // whether to go and delete photos, so a message that cannot be trusted is
    // rejected at the boundary rather than drawn.
    expect(isReceiveWorkerEvent(progressEvent({
      ...emptyProgress(),
      storageConfidence: 'plenty' as never,
    }))).toBe(false);
    expect(isReceiveWorkerEvent(progressEvent({
      ...emptyProgress(),
      storageRequiredBytes: -1,
    }))).toBe(false);
    expect(isReceiveWorkerEvent(progressEvent({
      ...emptyProgress(),
      storageAvailableBytes: Number.NaN,
    }))).toBe(false);
  });

  it('bumps the protocol version, so a stale worker cannot half-answer', () => {
    // A service worker can serve a cached shell against a fresh worker bundle.
    // The new fields would be absent, the guard would refuse them, and the
    // version is what turns that into a clean handshake failure.
    expect(RECEIVE_WORKER_PROTOCOL).toBeGreaterThanOrEqual(5);
  });
});
