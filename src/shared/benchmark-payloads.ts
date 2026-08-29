/**
 * Canonical benchmark payloads — deterministic, incompressible.
 *
 * Requirement: 100 KiB, 1 MiB, optionally 5 MiB incompressible.
 * "Never use highly compressible content for throughput records."
 *
 * Uses a deterministic PRNG (LCG) seeded by payload size so runs are
 * reproducible and no user file is read. Bytes are uniform pseudo-random
 * and therefore incompressible (gzip ratio ~1.0, verified in Phase 08).
 */

export const CANONICAL_SIZES = {
  /** 100 KiB */
  SMALL: 100 * 1024,
  /** 1 MiB */
  MEDIUM: 1024 * 1024,
  /** 5 MiB (optional, larger tiers) */
  LARGE: 5 * 1024 * 1024,
} as const;

export type CanonicalSizeLabel = '100KiB' | '1MiB' | '5MiB';

export function canonicalSizeBytes(label: CanonicalSizeLabel): number {
  switch (label) {
    case '100KiB': return CANONICAL_SIZES.SMALL;
    case '1MiB': return CANONICAL_SIZES.MEDIUM;
    case '5MiB': return CANONICAL_SIZES.LARGE;
  }
}

/**
 * Deterministic incompressible bytes — same output for same size every run.
 * LCG: state = imul(state, 1664525) + 1013904223
 * Seed is size-dependent so different sizes don't share prefixes.
 */
export function generateCanonicalPayload(label: CanonicalSizeLabel, seedOverride?: number): Uint8Array {
  const length = canonicalSizeBytes(label);
  return generateIncompressiblePayload(length, seedOverride ?? (0xC0FFEE ^ length));
}

export function generateIncompressiblePayload(length: number, seed: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0) throw new Error(`length must be non-negative integer, got ${length}`);
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24; // high byte has best entropy
  }
  return out;
}

export interface CanonicalPayloadDescriptor {
  label: CanonicalSizeLabel;
  bytes: number;
  sha256Hex?: string; // filled when hashed
  incompressible: true;
}

export function describeCanonicalPayloads(): CanonicalPayloadDescriptor[] {
  return [
    { label: '100KiB', bytes: CANONICAL_SIZES.SMALL, incompressible: true },
    { label: '1MiB', bytes: CANONICAL_SIZES.MEDIUM, incompressible: true },
    { label: '5MiB', bytes: CANONICAL_SIZES.LARGE, incompressible: true },
  ];
}
