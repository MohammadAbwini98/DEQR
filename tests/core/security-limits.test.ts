import { describe, expect, it } from 'vitest';

import {
  RECEIVER_POLICY,
  manifestPolicyRefusal,
  worstCaseDecoderBytes,
} from '../../src/core/receiver-policy';
import {
  V2_COMPRESSION_WINDOW,
  V2_DATA_LAYOUT,
  V2_FEC_PROFILE,
  V2_COMPRESSION,
  V2_LIMITS,
  V2_MANIFEST_LAYOUT,
  parseManifestFrame,
  planSegmentation,
  serializeDataFrame,
  serializeManifestFrame,
  V2_FRAME_TYPE,
} from '../../src/core/protocol-v2';
import {
  DEFAULT_MAX_ACTIVE_SEGMENTS,
  DEFAULT_MAX_SEGMENT_COUNT,
} from '../../src/core/segmented-receiver';
import {
  PENDING_NEIGHBOR_REFS_PER_SYMBOL,
  defaultSegmentDecoderLimits,
} from '../../src/core/segment-decoder';

/**
 * The receiver's resource policy, as one testable object.
 *
 * Phase 10's premise is that a limit written down twice is a limit that will
 * disagree with itself, so this file exists to hold the single copy to two
 * standards that a scattered set of constants could not be held to at all:
 *
 * - **Policy never exceeds the wire format.** A receiver may refuse anything;
 *   it may never accept something the protocol cannot express. Every derived
 *   bound is checked against `V2_LIMITS` rather than against a number typed
 *   into this file, so a narrowing of the format narrows these with it.
 * - **The modules that enforce the policy read the policy.** The assertions
 *   below compare `RECEIVER_POLICY` against the constants the decoder and the
 *   segmented receiver actually use. If someone reintroduces a literal, this
 *   fails - which is the only way "centralized" means anything.
 */

describe('the receiver policy is internally coherent', () => {
  it('states a finite, positive bound for every quantity a hostile stream influences', () => {
    for (const [name, value] of Object.entries(RECEIVER_POLICY)) {
      if (typeof value === 'bigint') {
        expect(value > 0n, `${name} must be positive`).toBe(true);
        continue;
      }
      expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      expect(value, `${name} must be positive`).toBeGreaterThan(0);
    }
  });

  it('covers every maximum the phase brief enumerates', () => {
    // Named individually rather than counted, so adding a limit does not
    // silently satisfy the check and removing one is a failure rather than a
    // smaller number.
    const required = [
      'maxManifestFrameBytes',
      'maxFilenameBytes',
      'maxDataFrameBytes',
      'maxSegmentSizeBytes',
      'maxSourceSymbolsPerSegment',
      'pendingNeighborRefsPerSymbol',
      'trackedRepairIdsPerSymbol',
      'maxSegmentCount',
      'maxActiveSegments',
      'maxFramesInFlight',
      'maxCheckpointBytes',
      'maxDecompressedWindowBytes',
      'maxFramePixelBytes',
    ] as const;
    for (const name of required) {
      expect(RECEIVER_POLICY, `policy is missing ${name}`).toHaveProperty(name);
    }
  });
});

describe('policy never widens the wire format', () => {
  it('derives the frame bounds from the layout rather than restating them', () => {
    expect(RECEIVER_POLICY.maxManifestFrameBytes).toBe(
      V2_MANIFEST_LAYOUT.fixedTotalBytes + V2_LIMITS.maxFilenameBytes + V2_LIMITS.maxMimeBytes,
    );
    expect(RECEIVER_POLICY.minManifestFrameBytes).toBe(
      V2_MANIFEST_LAYOUT.fixedTotalBytes + V2_LIMITS.minFilenameBytes,
    );
    expect(RECEIVER_POLICY.maxDataFrameBytes).toBe(
      V2_DATA_LAYOUT.overheadBytes + V2_LIMITS.maxSymbolSizeBytes,
    );
    expect(RECEIVER_POLICY.maxFrameBytes).toBe(
      Math.max(RECEIVER_POLICY.maxManifestFrameBytes, RECEIVER_POLICY.maxDataFrameBytes),
    );
  });

  it('narrows the u32 segment count rather than honouring it', () => {
    // The protocol field is a u32. Honouring it literally means allocating a
    // 512 MB completion bitmap from an untrusted manifest.
    expect(RECEIVER_POLICY.maxSegmentCount).toBeLessThan(V2_LIMITS.maxSegmentCount);
    expect(RECEIVER_POLICY.maxCommittedBitmapBytes).toBe(
      Math.ceil(RECEIVER_POLICY.maxSegmentCount / 8),
    );
  });

  it('bounds symbols per segment by the largest segment over the smallest symbol', () => {
    expect(RECEIVER_POLICY.maxSourceSymbolsPerSegment).toBe(
      V2_LIMITS.maxSegmentSizeBytes / V2_LIMITS.minSymbolSizeBytes,
    );
    expect(RECEIVER_POLICY.maxSourceSymbolsPerSegment).toBeLessThan(V2_LIMITS.maxSymbolsPerSegment);
  });

  it('keeps the compression window inside the protocol range', () => {
    expect(RECEIVER_POLICY.minCompressionWindowLog2).toBe(V2_COMPRESSION_WINDOW.minLog2);
    expect(RECEIVER_POLICY.maxCompressionWindowLog2).toBe(V2_COMPRESSION_WINDOW.maxLog2);
    expect(RECEIVER_POLICY.maxDecompressedWindowBytes).toBe(2 ** V2_COMPRESSION_WINDOW.maxLog2);
  });

  it('admits every frame the serializer can produce', () => {
    // Swept rather than argued: if a legal configuration produced a frame
    // above `maxFrameBytes`, the pipeline's length guard would refuse a valid
    // transfer, which is a worse failure than the one it prevents.
    for (const symbolSizeBytes of [32, 256, 1_139, 2_048, V2_LIMITS.maxSymbolSizeBytes]) {
      const frame = serializeDataFrame({
        frameType: V2_FRAME_TYPE.SOURCE,
        sessionId: 1,
        fileId: 2,
        segmentIndex: 0,
        symbolId: 0,
        sourceSymbolCount: 8,
        frameFlags: 0,
        payload: new Uint8Array(symbolSizeBytes).fill(0x41),
      });
      expect(frame.length).toBeLessThanOrEqual(RECEIVER_POLICY.maxFrameBytes);
    }

    // A filename at the sanitizer's own ceiling, in four-byte code points, is
    // the largest manifest this build can write.
    const wideName = '\u{1F600}'.repeat(200);
    const transportSize = 1_000_000n;
    const plan = planSegmentation({ transportSize, segmentSizeBytes: 65_536, symbolSizeBytes: 512 });
    const manifest = serializeManifestFrame({
      featureFlags: 0,
      sessionId: 1,
      fileId: 2,
      originalSize: transportSize,
      transportSize,
      segmentSizeBytes: 65_536,
      symbolSizeBytes: 512,
      segmentCount: plan.segmentCount,
      fecProfileId: V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1,
      compressionMode: V2_COMPRESSION.NONE,
      compressionParam: 0,
      transportProfileId: 0,
      sha256: new Uint8Array(32).fill(0x11),
      filename: wideName,
      mimeType: 'x'.repeat(V2_LIMITS.maxMimeBytes),
    });
    expect(manifest.length).toBeLessThanOrEqual(RECEIVER_POLICY.maxManifestFrameBytes);
    expect(parseManifestFrame(manifest).ok).toBe(true);
  });
});

describe('the enforcing modules read the policy', () => {
  it('is where the segmented receiver takes its defaults from', () => {
    expect(DEFAULT_MAX_SEGMENT_COUNT).toBe(RECEIVER_POLICY.maxSegmentCount);
    expect(DEFAULT_MAX_ACTIVE_SEGMENTS).toBe(RECEIVER_POLICY.maxActiveSegments);
  });

  it('is where the segment decoder takes its work caps from', () => {
    expect(PENDING_NEIGHBOR_REFS_PER_SYMBOL).toBe(RECEIVER_POLICY.pendingNeighborRefsPerSymbol);
    const limits = defaultSegmentDecoderLimits(1_000);
    expect(limits.maxPendingEquations).toBe(1_000);
    expect(limits.maxPendingNeighborRefs).toBe(
      RECEIVER_POLICY.pendingNeighborRefsPerSymbol * 1_000 + RECEIVER_POLICY.pendingNeighborRefsFloor,
    );
    expect(limits.maxTrackedRepairIds).toBe(
      RECEIVER_POLICY.trackedRepairIdsPerSymbol * 1_000 + RECEIVER_POLICY.trackedRepairIdsFloor,
    );
  });
});

describe('manifestPolicyRefusal', () => {
  const legal = {
    segmentCount: 16,
    segmentSizeBytes: 65_536,
    symbolSizeBytes: 512,
    transportSize: 1_000_000n,
  };

  it('accepts an ordinary transfer', () => {
    expect(manifestPolicyRefusal(legal)).toBeNull();
  });

  it('accepts the largest segmentation the policy admits', () => {
    expect(
      manifestPolicyRefusal({
        segmentCount: RECEIVER_POLICY.maxSegmentCount,
        segmentSizeBytes: RECEIVER_POLICY.maxSegmentSizeBytes,
        symbolSizeBytes: V2_LIMITS.minSymbolSizeBytes,
        transportSize: RECEIVER_POLICY.maxTransportBytes,
      }),
    ).toBeNull();
  });

  it('refuses one segment past the bitmap budget', () => {
    expect(manifestPolicyRefusal({ ...legal, segmentCount: RECEIVER_POLICY.maxSegmentCount + 1 }))
      .toBe('SEGMENT_COUNT_EXCEEDED');
  });

  it('refuses a transport size past the product of the segment caps', () => {
    expect(
      manifestPolicyRefusal({ ...legal, transportSize: RECEIVER_POLICY.maxTransportBytes + 1n }),
    ).toBe('TRANSFER_TOO_LARGE');
  });

  it('refuses a segment larger than one decoder may hold', () => {
    expect(
      manifestPolicyRefusal({ ...legal, segmentSizeBytes: RECEIVER_POLICY.maxSegmentSizeBytes * 2 }),
    ).toBe('SEGMENT_TOO_LARGE');
  });

  it('refuses a segment holding more symbols than the per-segment caps assume', () => {
    // Same segment size, a symbol below the protocol minimum: the symbol count
    // it implies is what this catches, independently of the size check above.
    expect(
      manifestPolicyRefusal({
        ...legal,
        segmentSizeBytes: RECEIVER_POLICY.maxSegmentSizeBytes,
        symbolSizeBytes: 16,
      }),
    ).toBe('SEGMENT_TOO_LARGE');
  });

  it('is checked against fields rather than against a self-consistent manifest', () => {
    // The parser has already proved consistency by the time this runs, so the
    // policy is free to be a flat field check - and being one is what makes it
    // a second, independent line rather than a restatement of the first.
    expect(
      manifestPolicyRefusal({
        segmentCount: 1,
        segmentSizeBytes: 65_536,
        symbolSizeBytes: 512,
        transportSize: 1n << 60n,
      }),
    ).toBe('TRANSFER_TOO_LARGE');
  });
});

describe('worstCaseDecoderBytes', () => {
  it('counts the segment, the bitmap and a full set of equations, per active decoder', () => {
    const perSegment = 65_536 + Math.ceil(128 / 8) + 128 * 512;
    expect(worstCaseDecoderBytes(65_536, 512)).toBe(perSegment * RECEIVER_POLICY.maxActiveSegments);
  });

  it('stays inside a phone budget at the largest profile segment', () => {
    // 2 MiB segments at 1,139-byte symbols is the widest Phase 04 profile. The
    // point of the number is that it does not grow with the file, so a bound
    // that a device can hold at the widest profile holds for every transfer.
    expect(worstCaseDecoderBytes(2 * 1024 * 1024, 1_139)).toBeLessThan(16 * 1024 * 1024);
  });
});
