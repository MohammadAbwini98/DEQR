/**
 * Choosing where a transfer's bytes go, before the first one arrives.
 *
 * The pipeline does not know what a `SegmentStore` is made of, and this is the
 * module that decides. It runs once per session, at the manifest, because that
 * is the first moment the receiver knows how large the transfer is - and size
 * is the only input to the decision that matters.
 *
 * ## The order is the design
 *
 * 1. **Can this context write to a device at all?** OPFS with a synchronous
 *    access handle, which in practice means a worker on a current browser.
 * 2. **Is there plausibly room?** The browser's own estimate, plus a margin,
 *    checked before anything is created. This can be wrong in both directions
 *    and says so; it is here to catch the clearly-impossible case cheaply.
 * 3. **Does the device actually accept it?** Creating the file and pre-sizing
 *    it to the full transport size. This is the check that is not a guess.
 *
 * Only after all three does scanning begin. A user who is going to be told
 * "not enough room" should be told it in the second after they press Receive,
 * not after they have held a phone steady for forty minutes.
 *
 * ## The fallback is deliberately small
 *
 * A browser without OPFS gets `BoundedMemorySegmentStore` and about nine
 * megabytes. That is not a degraded storage tier, it is enough to prove the
 * path works, and any transfer that does not fit is refused up front rather
 * than allowed to grow the tab until the platform kills it. Reporting that
 * honestly is the whole reason this returns a code instead of a boolean.
 */

import type { DeqrV2Manifest, SegmentPlan } from '../../src/core/protocol-v2';
import { V2_COMPRESSION, toSafeNumber } from '../../src/core/protocol-v2';
import { OpfsSegmentStore } from './opfs-segment-store';
import {
  DEFAULT_STORAGE_MARGIN_RATIO,
  defaultEnvironment,
  detectStorageSupport,
  preflightStorage,
  sweepStaleSessions,
  type CheckpointAdoption,
  type CheckpointRejection,
  type StorageEnvironment,
  type StoragePreflight,
  type SweepOptions,
} from './opfs';
import {
  BoundedMemorySegmentStore,
  DEFAULT_SEGMENT_BUDGET_BYTES,
  type SegmentStore,
  type SegmentStoreKind,
} from './segment-store';

/** Why a session cannot be given storage. Enumerated; these reach the UI. */
export type StorageFailureCode =
  /** There is storage, and not enough of it for this transfer. */
  | 'INSUFFICIENT_STORAGE'
  /** This browser cannot hold a transfer of this size at all. */
  | 'STORAGE_UNAVAILABLE'
  /** Storage exists and refused to open. */
  | 'STORAGE_OPEN_FAILED';

export type StorageProvision =
  | {
      ok: true;
      store: SegmentStore;
      kind: SegmentStoreKind;
      preflight?: StoragePreflight;
      /** Present when working data from an earlier run was adopted. */
      adopted?: CheckpointAdoption;
      /** Why data that was on the device was not adopted. */
      rejection?: CheckpointRejection;
    }
  | { ok: false; code: StorageFailureCode; preflight?: StoragePreflight };

/** The seam the pipeline holds. Injected, so a test never touches a real device. */
export interface StorageProvisioner {
  provision(
    manifest: DeqrV2Manifest,
    plan: SegmentPlan,
    filename: string,
    options?: ProvisionOptions,
  ): Promise<StorageProvision>;
}

export interface ProvisionOptions {
  /**
   * Look for and adopt a checkpoint from an earlier run of this same transfer.
   *
   * Asked for per session rather than configured once, because whether a
   * resume is wanted is a property of the moment - a user restarting an
   * interrupted transfer - and not of the device.
   */
  resume?: boolean;
}

export interface ReceiverStorageOptions {
  environment?: StorageEnvironment;
  /** Free space required on top of the transfer, as a fraction of its size. */
  marginRatio?: number;
  /** Ceiling for the no-OPFS fallback. */
  fallbackBudgetBytes?: number;
  /** Set false to refuse rather than fall back to memory. */
  allowMemoryFallback?: boolean;
  sweep?: SweepOptions;
  now?: () => number;
}

export class ReceiverStorage implements StorageProvisioner {
  private readonly environment: StorageEnvironment;
  private readonly marginRatio: number;
  private readonly fallbackBudgetBytes: number;
  private readonly allowMemoryFallback: boolean;
  private readonly sweep: SweepOptions | undefined;
  private readonly now: () => number;

  constructor(options: ReceiverStorageOptions = {}) {
    this.environment = options.environment ?? defaultEnvironment();
    this.marginRatio = options.marginRatio ?? DEFAULT_STORAGE_MARGIN_RATIO;
    this.fallbackBudgetBytes = options.fallbackBudgetBytes ?? DEFAULT_SEGMENT_BUDGET_BYTES;
    this.allowMemoryFallback = options.allowMemoryFallback ?? true;
    this.sweep = options.sweep;
    this.now = options.now ?? (() => Date.now());
  }

  async provision(
    manifest: DeqrV2Manifest,
    plan: SegmentPlan,
    filename: string,
    options: ProvisionOptions = {},
  ): Promise<StorageProvision> {
    // What the device has to find room for, which is not the same as the size
    // of the transfer. A compressed transfer needs the container *and* the file
    // it expands into, both at once, because the second is written while the
    // first is still being read. Asking for only the container would put the
    // refusal an hour later, at decompression, which is exactly the failure the
    // pre-sizing design exists to move to the front.
    let requiredBytes: number;
    try {
      const transportSize = toSafeNumber(manifest.transportSize, 'transportSize');
      requiredBytes = manifest.compressionMode === V2_COMPRESSION.NONE
        ? transportSize
        : transportSize + toSafeNumber(manifest.originalSize, 'originalSize');
    } catch {
      return { ok: false, code: 'STORAGE_OPEN_FAILED' };
    }

    const support = detectStorageSupport(this.environment);
    if (!support.opfs || !support.syncAccess) return this.fallback(requiredBytes);

    const preflight = await preflightStorage(requiredBytes, this.environment, this.marginRatio);
    if (!preflight.ok) return { ok: false, code: 'INSUFFICIENT_STORAGE', preflight };

    let root;
    try {
      root = await this.environment.storage!.getDirectory!();
    } catch {
      return this.fallback(requiredBytes, preflight);
    }

    const opened = await OpfsSegmentStore.open({
      root,
      manifest,
      plan,
      filename,
      now: this.now,
      sweep: this.sweep,
      resume: options.resume === true,
    });
    if (opened.ok) {
      return {
        ok: true,
        store: opened.store,
        kind: 'opfs',
        preflight,
        adopted: opened.adopted,
        rejection: opened.rejection,
      };
    }

    switch (opened.code) {
      case 'STORAGE_UNAVAILABLE':
      case 'STORAGE_UNSUPPORTED':
        // The capability check said yes and the device said no. That is a
        // browser this build has not seen, and memory is still a real answer
        // for a small transfer.
        return this.fallback(requiredBytes, preflight);
      case 'INSUFFICIENT_STORAGE':
        return { ok: false, code: 'INSUFFICIENT_STORAGE', preflight };
      default:
        return { ok: false, code: 'STORAGE_OPEN_FAILED', preflight };
    }
  }

  /** Memory, if the transfer is small enough for it to be an honest answer. */
  private fallback(requiredBytes: number, preflight?: StoragePreflight): StorageProvision {
    if (!this.allowMemoryFallback || requiredBytes > this.fallbackBudgetBytes) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', preflight };
    }
    return {
      ok: true,
      store: new BoundedMemorySegmentStore(this.fallbackBudgetBytes),
      kind: 'memory',
      preflight,
    };
  }
}

/**
 * What the browser says this origin has left, with no transfer in mind.
 *
 * The size-aware check is `preflightStorage`, which needs a manifest. This one
 * answers the question the receive screen has to answer *before* a camera is
 * opened: is there plausibly room on this device at all. `measured` is false
 * when the browser has no estimate API, and the caller must not turn that into
 * a reassurance - it is the absence of an answer, not a good one.
 */
export async function estimateDeviceStorage(
  environment: StorageEnvironment = defaultEnvironment(),
): Promise<{ availableBytes: number; measured: boolean }> {
  const estimate = environment.storage?.estimate;
  if (typeof estimate !== 'function') return { availableBytes: 0, measured: false };
  try {
    const reported = await estimate.call(environment.storage);
    const quota = typeof reported?.quota === 'number' ? reported.quota : undefined;
    if (quota === undefined) return { availableBytes: 0, measured: false };
    const usage = typeof reported?.usage === 'number' ? reported.usage : 0;
    return { availableBytes: Math.max(0, quota - usage), measured: true };
  } catch {
    // An estimate that throws is an estimate that does not exist.
    return { availableBytes: 0, measured: false };
  }
}

/**
 * Deletes every partly-received transfer this origin is holding.
 *
 * The receiver keeps an interrupted transfer's bytes on purpose - that is what
 * Phase 07's resume is built on - and a time-and-count sweep bounds how long
 * "on purpose" lasts. What was missing was a way for the *user* to end it now:
 * the data sits in origin-private storage, which the Files app cannot see and
 * the user cannot clear, so without this the only way to reclaim it was to wait
 * out the retention or delete the whole site's data.
 *
 * Implemented as the existing sweep with both bounds set to zero, rather than
 * as a second deletion path, so there is exactly one piece of code that removes
 * a session directory. Returns the names it removed, which is what makes it
 * testable rather than merely stated.
 */
export async function discardRetainedSessions(
  environment: StorageEnvironment = defaultEnvironment(),
): Promise<string[]> {
  const getDirectory = environment.storage?.getDirectory;
  if (typeof getDirectory !== 'function') return [];
  try {
    // The OPFS root, not the sessions directory: `sweepStaleSessions` resolves
    // `/deqr/sessions` for itself, exactly as `OpfsSegmentStore.open` does.
    // Handing it the already-resolved directory made it look for a second
    // `deqr/sessions` inside the first and find nothing to delete.
    const root = await getDirectory.call(environment.storage);
    return await sweepStaleSessions(root, { retentionMs: 0, maxRetained: 0 });
  } catch {
    // A discard that cannot reach storage has nothing to report and nothing to
    // fix; the retention sweep will take the same directories on its schedule.
    return [];
  }
}

/** A provisioner that always hands back the same store. For tests and benches. */
export function fixedProvisioner(store: SegmentStore): StorageProvisioner {
  return {
    async provision() {
      return { ok: true, store, kind: store.kind };
    },
  };
}
