/**
 * The one thing that travels back up an optical link: a resume token.
 *
 * DEQR's channel is a display and a camera pointed at it. Data flows one way
 * and there is no acknowledgement path, so a receiver cannot tell a sender what
 * it already has. Every resume design that assumes it can is unimplementable
 * here.
 *
 * What *is* available is the user. They are holding the phone and standing at
 * the desktop, and they can carry forty characters between the two. So the
 * receiver renders one short token describing where it got to, and the sender
 * reads it and restarts from there. That is the whole protocol, and it is
 * deliberately the smallest thing that can work:
 *
 * - It carries **identity** - session, file, and a prefix of the file's digest
 *   - so a sender cannot resume the wrong file into a partial one.
 * - It carries **the plan's segment count**, so a sender whose segmentation
 *   differs (a different transport profile, a different build) is refused
 *   rather than allowed to write segment 900 of 1,000 into a file that has
 *   1,200.
 * - It carries **one segment index**: the lowest one the receiver still needs.
 *   Not a bitmap of everything missing, which would be hundreds of characters
 *   for a large transfer, and not a byte offset, which would not survive a
 *   change of segmentation.
 *
 * ## Why the lowest missing segment, and not the set
 *
 * The sender emits segments in order, so a receiver's progress is a prefix with
 * at most a few gaps at its leading edge. Restarting at the lowest missing
 * index therefore replays very little in the common case, and in every case it
 * is *conservative*: the sender resends some segments the receiver already has,
 * and the receiver refuses them with one bit test. Nothing is corrupted by a
 * replay and nothing is skipped by mistake.
 *
 * The alternative - a compressed set of exactly the missing segments - saves
 * channel time in a case that is rare and costs a token nobody can read aloud.
 *
 * ## What this token is not
 *
 * It is not an integrity mechanism. The digest prefix is five bytes: enough to
 * stop a user resuming last week's transfer onto this week's, not enough to be
 * called a check. **SHA-256 over the reconstructed file remains the only
 * authority**, it runs at the end of every transfer including a resumed one,
 * and a resumed transfer that does not match it fails exactly as a fresh one
 * would.
 *
 * ## Encoding
 *
 * Twenty-five bytes, which is two hundred bits, which is exactly forty
 * Crockford base32 characters with nothing left over. Crockford rather than
 * standard base32 because this string is read off one screen and typed into
 * another: its alphabet has no `I`, `L`, `O` or `U`, and its decoder folds
 * `I`/`L` onto `1` and `O` onto `0`, so the three confusions a person actually
 * makes are handled rather than rejected. Case is ignored and separators are
 * ignored, so a token typed without its hyphens still works.
 *
 * A truncated CRC-32 occupies the last three bytes. It is a typo guard, not a
 * security property: it catches every single-character substitution and the
 * overwhelming majority of transpositions, which is what turns "this token is
 * wrong" into an answer the desktop can give immediately instead of forty
 * minutes later.
 */

import { crc32 } from './crc32.js';

/** Bumped if a field changes meaning. A reader refuses a version it does not know. */
export const RESUME_TOKEN_VERSION = 1;

/** Bytes before base32. Exactly 200 bits, so the encoding has no padding. */
export const RESUME_TOKEN_BYTES = 25;

/** Characters in an encoded token, separators excluded. */
export const RESUME_TOKEN_CHARS = 40;

/** Characters per group in the display form. */
export const RESUME_TOKEN_GROUP = 5;

/** Bytes of the manifest's SHA-256 carried, from the front. */
export const RESUME_TOKEN_DIGEST_BYTES = 5;

/**
 * Crockford base32.
 *
 * No `I`, `L`, `O` or `U`: the first three because they are misread as `1`,
 * `1` and `0`, and `U` because excluding it is what keeps an accidental
 * obscenity out of a token a user has to read aloud.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Reverse map, including the substitutions a person makes rather than only the ones the spec allows. */
const DECODE = new Map<string, number>();
for (let index = 0; index < ALPHABET.length; index += 1) DECODE.set(ALPHABET[index], index);
DECODE.set('I', 1);
DECODE.set('L', 1);
DECODE.set('O', 0);

export interface ResumeToken {
  version: number;
  sessionId: number;
  fileId: number;
  /** Segments the sender's plan divides the file into. Must match on both sides. */
  segmentCount: number;
  /** Lowest segment index the receiver has not committed. The sender restarts here. */
  resumeFromSegment: number;
  /** First `RESUME_TOKEN_DIGEST_BYTES` of the manifest's SHA-256. */
  digestPrefix: Uint8Array;
}

export type ResumeTokenErrorCode =
  /** Not the right number of characters once separators are removed. */
  | 'RESUME_TOKEN_LENGTH'
  /** A character outside the alphabet, and not one of the folded confusions. */
  | 'RESUME_TOKEN_CHARSET'
  /** The checksum disagrees. Almost always a typo. */
  | 'RESUME_TOKEN_CHECKSUM'
  /** A token from a build that writes a different shape. */
  | 'RESUME_TOKEN_VERSION'
  /** Structurally sound and self-contradictory: a resume point past the end. */
  | 'RESUME_TOKEN_RANGE';

export type ResumeTokenResult =
  | { ok: true; value: ResumeToken }
  | { ok: false; code: ResumeTokenErrorCode };

export interface ResumeTokenInput {
  sessionId: number;
  fileId: number;
  segmentCount: number;
  resumeFromSegment: number;
  /** The manifest's full 32-byte digest; only its prefix is carried. */
  sha256: Uint8Array;
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function writeU32(into: Uint8Array, at: number, value: number): void {
  into[at] = (value >>> 24) & 0xff;
  into[at + 1] = (value >>> 16) & 0xff;
  into[at + 2] = (value >>> 8) & 0xff;
  into[at + 3] = value & 0xff;
}

function readU32(from: Uint8Array, at: number): number {
  return ((from[at] << 24) | (from[at + 1] << 16) | (from[at + 2] << 8) | from[at + 3]) >>> 0;
}

/**
 * Packs a token's fields into their 25 bytes.
 *
 * Separated from the base32 step so a test can assert the layout directly, and
 * so the checksum is computed over bytes rather than over characters - a CRC
 * over the encoded form would be sensitive to how the token happened to be
 * grouped.
 */
export function encodeResumeTokenBytes(input: ResumeTokenInput): Uint8Array {
  const { sessionId, fileId, segmentCount, resumeFromSegment, sha256 } = input;
  if (!isU32(sessionId) || !isU32(fileId)) {
    throw new RangeError('sessionId and fileId must be unsigned 32-bit integers');
  }
  if (!isU32(segmentCount) || segmentCount < 1) {
    throw new RangeError(`segmentCount must be a positive unsigned 32-bit integer, received ${segmentCount}`);
  }
  if (!isU32(resumeFromSegment) || resumeFromSegment > segmentCount) {
    // Equal to `segmentCount` is legal and means "nothing left": a receiver
    // that has every segment but has not verified still has a token to show.
    throw new RangeError(`resumeFromSegment must be in 0..${segmentCount}, received ${resumeFromSegment}`);
  }
  if (sha256.length < RESUME_TOKEN_DIGEST_BYTES) {
    throw new RangeError(`sha256 must carry at least ${RESUME_TOKEN_DIGEST_BYTES} bytes`);
  }

  const bytes = new Uint8Array(RESUME_TOKEN_BYTES);
  bytes[0] = RESUME_TOKEN_VERSION;
  writeU32(bytes, 1, sessionId);
  writeU32(bytes, 5, fileId);
  writeU32(bytes, 9, segmentCount);
  writeU32(bytes, 13, resumeFromSegment);
  bytes.set(sha256.subarray(0, RESUME_TOKEN_DIGEST_BYTES), 17);

  const checksum = crc32(bytes, 0, 22);
  bytes[22] = (checksum >>> 16) & 0xff;
  bytes[23] = (checksum >>> 8) & 0xff;
  bytes[24] = checksum & 0xff;
  return bytes;
}

/** Base32 over exactly 25 bytes. No padding, because 200 bits divides by five. */
function toBase32(bytes: Uint8Array): string {
  let output = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(accumulator >>> bits) & 0x1f];
    }
  }
  return output;
}

/**
 * The token a receiver shows and a user carries.
 *
 * Grouped by default because forty unbroken characters is a string people lose
 * their place in. The separators are cosmetic and the reader ignores them, so a
 * token typed without them is the same token.
 */
export function encodeResumeToken(input: ResumeTokenInput, grouped = true): string {
  const raw = toBase32(encodeResumeTokenBytes(input));
  if (!grouped) return raw;
  const groups: string[] = [];
  for (let at = 0; at < raw.length; at += RESUME_TOKEN_GROUP) {
    groups.push(raw.slice(at, at + RESUME_TOKEN_GROUP));
  }
  return groups.join('-');
}

/**
 * Reads a token back, refusing rather than guessing.
 *
 * Every failure is a code because each one means something different to
 * whoever typed it: the wrong length is a token that was cut off, a bad
 * checksum is a typo worth retyping, and a version mismatch is two builds that
 * do not agree and no amount of retyping will fix.
 */
export function decodeResumeToken(text: string): ResumeTokenResult {
  // Separators are display sugar. A user who typed spaces, hyphens, both, or
  // neither has typed the same token.
  const clean = text.replace(/[\s-]+/g, '').toUpperCase();
  if (clean.length !== RESUME_TOKEN_CHARS) return { ok: false, code: 'RESUME_TOKEN_LENGTH' };

  const bytes = new Uint8Array(RESUME_TOKEN_BYTES);
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of clean) {
    const value = DECODE.get(character);
    if (value === undefined) return { ok: false, code: 'RESUME_TOKEN_CHARSET' };
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }

  const expected = crc32(bytes, 0, 22);
  const found = (bytes[22] << 16) | (bytes[23] << 8) | bytes[24];
  // Checked before the version, so a mistyped character is reported as the typo
  // it is rather than as an incompatible build.
  if (found !== (expected & 0xff_ffff)) return { ok: false, code: 'RESUME_TOKEN_CHECKSUM' };
  if (bytes[0] !== RESUME_TOKEN_VERSION) return { ok: false, code: 'RESUME_TOKEN_VERSION' };

  const segmentCount = readU32(bytes, 9);
  const resumeFromSegment = readU32(bytes, 13);
  if (segmentCount < 1 || resumeFromSegment > segmentCount) {
    return { ok: false, code: 'RESUME_TOKEN_RANGE' };
  }

  return {
    ok: true,
    value: {
      version: bytes[0],
      sessionId: readU32(bytes, 1),
      fileId: readU32(bytes, 5),
      segmentCount,
      resumeFromSegment,
      digestPrefix: bytes.slice(17, 17 + RESUME_TOKEN_DIGEST_BYTES),
    },
  };
}

/**
 * Whether a token describes the file a sender has open.
 *
 * Deliberately not folded together with the segmentation check: a segmentation
 * disagreement and a different file are different mistakes, and telling
 * someone which one they made is the difference between "use the same profile"
 * and "you picked the wrong file".
 */
export function resumeTokenMatchesDigest(token: ResumeToken, sha256: Uint8Array): boolean {
  if (sha256.length < RESUME_TOKEN_DIGEST_BYTES) return false;
  for (let index = 0; index < RESUME_TOKEN_DIGEST_BYTES; index += 1) {
    if (token.digestPrefix[index] !== sha256[index]) return false;
  }
  return true;
}

/* ------------------------------------------------- targeted recovery (v2) */

/**
 * A token that says *which* segments are missing, not just where to restart.
 *
 * v1's rationale — restart from the lowest missing segment — rests on an
 * assumption that holds for the case it was written for and fails for the case
 * Phase 13 found. After an *interruption*, a receiver's progress really is a
 * prefix: it stopped, so everything after the stopping point is missing, and
 * the lowest missing index describes it exactly.
 *
 * After a *completed pass*, it is not a prefix. The sender showed every frame
 * and the receiver's gaps are wherever the camera happened to lose them —
 * segments 1 and 91 of 100, say. "Restart at the lowest" then means resending
 * ninety of the ninety-two segments it already has, which on a link measured in
 * kilobytes per second is hours of transmitting things nobody needs.
 *
 * So v2 carries a bounded run-length list of the gaps. Bounded is the operative
 * word: the list is capped, and a receiver whose gaps do not fit **emits a v1
 * token instead** rather than a truncated v2 one. Falling back is conservative
 * in the same direction v1 always was — the sender resends more than necessary
 * and the receiver refuses the surplus with one bit test — so the failure mode
 * of "too fragmented to describe" is slowness, never loss.
 */
export const RESUME_TOKEN_VERSION_RANGES = 2;

/** Fixed size of a v2 token. 320 bits, so base32 divides it exactly. */
export const RESUME_TOKEN_V2_BYTES = 40;
export const RESUME_TOKEN_V2_CHARS = 64;

/** Bytes the run-length blob may occupy. Fixed, so the token has one length. */
export const RESUME_RANGE_BLOB_BYTES = 14;

/**
 * Gaps a token will describe before falling back to v1.
 *
 * Seven is what fits the blob in the worst realistic case rather than a round
 * number: gaps are encoded as two varints each, and a transfer whose gaps are
 * far apart in a large file spends two bytes on each.
 */
export const MAX_RESUME_RANGES = 7;

/** A run of consecutive segments the receiver does not have. */
export interface MissingRange {
  start: number;
  length: number;
}

/**
 * The gaps in a committed bitmap, as runs.
 *
 * Takes the bitmap rather than the receiver so it can be called from either
 * side of the worker boundary, and so a test can hand it a bitmap it wrote by
 * hand.
 */
export function missingRangesFromBitmap(
  committedBits: Uint8Array,
  segmentCount: number,
): MissingRange[] {
  const ranges: MissingRange[] = [];
  let runStart = -1;
  for (let index = 0; index < segmentCount; index += 1) {
    const committed = (committedBits[index >> 3] & (1 << (index & 7))) !== 0;
    if (!committed && runStart < 0) runStart = index;
    if (committed && runStart >= 0) {
      ranges.push({ start: runStart, length: index - runStart });
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push({ start: runStart, length: segmentCount - runStart });
  return ranges;
}

function writeVarint(into: number[], value: number): void {
  let remaining = value;
  while (remaining >= 0x80) {
    into.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  into.push(remaining & 0x7f);
}

function readVarint(from: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 1;
  let cursor = at;
  for (let step = 0; step < 5; step += 1) {
    if (cursor >= from.length) return null;
    const byte = from[cursor];
    cursor += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift *= 128;
  }
  return null;
}

/**
 * Packs gaps as (distance from the previous gap's end, run length - 1).
 *
 * Deltas rather than absolute indices because the distances are what stay
 * small: a file with gaps at 1 and 91 encodes 91 once, not twice, and a file
 * with adjacent gaps encodes single-byte values throughout.
 *
 * Returns null when the gaps do not fit, which is the caller's signal to emit a
 * v1 token rather than a lossy v2 one.
 */
function packRanges(ranges: readonly MissingRange[]): Uint8Array | null {
  if (ranges.length === 0 || ranges.length > MAX_RESUME_RANGES) return null;
  const blob: number[] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.start < previousEnd || range.length < 1) return null;
    writeVarint(blob, range.start - previousEnd);
    writeVarint(blob, range.length - 1);
    previousEnd = range.start + range.length;
    if (blob.length > RESUME_RANGE_BLOB_BYTES) return null;
  }
  return Uint8Array.from(blob);
}

function unpackRanges(blob: Uint8Array, segmentCount: number): MissingRange[] | null {
  const ranges: MissingRange[] = [];
  let cursor = 0;
  let previousEnd = 0;
  while (cursor < blob.length) {
    const gap = readVarint(blob, cursor);
    if (!gap) return null;
    const run = readVarint(blob, gap.next);
    if (!run) return null;
    cursor = run.next;

    const start = previousEnd + gap.value;
    const length = run.value + 1;
    // Every bound checked before anything is allocated against it. A token is
    // untrusted text a person typed, and this one drives what a sender spends
    // hours transmitting.
    if (start < previousEnd || length < 1) return null;
    if (start + length > segmentCount) return null;
    ranges.push({ start, length });
    previousEnd = start + length;
    if (ranges.length > MAX_RESUME_RANGES) return null;
  }
  return ranges;
}

/**
 * Emits the most useful token the gaps allow.
 *
 * v2 when the gaps fit the blob, v1 when they do not — and the caller does not
 * choose, because the choice is a property of the data rather than a preference.
 * A v1 fallback is always correct: it names the lowest missing segment, which
 * every reader understands, and it costs transmission rather than accuracy.
 */
/**
 * Whether these gaps are just "everything from here on".
 *
 * The shape an interruption leaves, and the one v1 encodes exactly.
 */
function describesATrailingRun(
  ranges: readonly MissingRange[],
  segmentCount: number,
): boolean {
  if (ranges.length === 0) return true;
  if (ranges.length > 1) return false;
  return ranges[0].start + ranges[0].length >= segmentCount;
}

export function encodeTargetedResumeToken(
  input: ResumeTokenInput & { missing?: readonly MissingRange[] },
  grouped = true,
): string {
  // v1 when v1 already says it. A token is read off one screen and typed into
  // another, so twenty-four extra characters have to buy something.
  //
  // They buy nothing for the case Phase 07 was written for. An *interrupted*
  // receiver's gaps are one run reaching the end of the file, which is exactly
  // what "restart from the lowest missing segment" means - so v2 would encode
  // the same instruction at 64 characters instead of 40. Only a set v1 cannot
  // express is worth the longer token, and after a completed pass that is
  // precisely what scattered gaps are.
  const blob = input.missing && !describesATrailingRun(input.missing, input.segmentCount)
    ? packRanges(input.missing)
    : null;
  if (!blob) return encodeResumeToken(input, grouped);

  const bytes = new Uint8Array(RESUME_TOKEN_V2_BYTES);
  // The first 22 bytes are v1's layout unchanged, so a v2 token can be read for
  // its identity and restart point by anything that understands the header.
  bytes.set(encodeResumeTokenBytes(input).subarray(0, 22), 0);
  bytes[0] = RESUME_TOKEN_VERSION_RANGES;
  bytes[22] = blob.length;
  bytes.set(blob, 23);

  const checksum = crc32(bytes, 0, RESUME_TOKEN_V2_BYTES - 3);
  bytes[37] = (checksum >>> 16) & 0xff;
  bytes[38] = (checksum >>> 8) & 0xff;
  bytes[39] = checksum & 0xff;

  const raw = toBase32(bytes);
  if (!grouped) return raw;
  const groups: string[] = [];
  for (let at = 0; at < raw.length; at += RESUME_TOKEN_GROUP) {
    groups.push(raw.slice(at, at + RESUME_TOKEN_GROUP));
  }
  return groups.join('-');
}

/** A decoded token, plus the gaps when it carried them. */
export interface TargetedResumeToken extends ResumeToken {
  /** Absent on a v1 token, which describes a restart point rather than a set. */
  missing?: MissingRange[];
}

export type TargetedResumeTokenResult =
  | { ok: true; value: TargetedResumeToken }
  | { ok: false; code: ResumeTokenErrorCode };

/**
 * Reads either token shape, refusing rather than guessing.
 *
 * Length picks the branch, because the two shapes are different lengths by
 * construction and a token of neither length is truncated or padded — which is
 * the same answer v1 already gave.
 */
export function decodeTargetedResumeToken(text: string): TargetedResumeTokenResult {
  const clean = text.replace(/[\s-]+/g, '').toUpperCase();
  if (clean.length === RESUME_TOKEN_CHARS) return decodeResumeToken(text);
  if (clean.length !== RESUME_TOKEN_V2_CHARS) return { ok: false, code: 'RESUME_TOKEN_LENGTH' };

  const bytes = new Uint8Array(RESUME_TOKEN_V2_BYTES);
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of clean) {
    const value = DECODE.get(character);
    if (value === undefined) return { ok: false, code: 'RESUME_TOKEN_CHARSET' };
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (written < RESUME_TOKEN_V2_BYTES) bytes[written] = (accumulator >>> bits) & 0xff;
      written += 1;
    }
  }

  const expected = crc32(bytes, 0, RESUME_TOKEN_V2_BYTES - 3) & 0xff_ffff;
  const found = (bytes[37] << 16) | (bytes[38] << 8) | bytes[39];
  if (found !== expected) return { ok: false, code: 'RESUME_TOKEN_CHECKSUM' };
  if (bytes[0] !== RESUME_TOKEN_VERSION_RANGES) return { ok: false, code: 'RESUME_TOKEN_VERSION' };

  const segmentCount = readU32(bytes, 9);
  const resumeFromSegment = readU32(bytes, 13);
  if (segmentCount < 1 || resumeFromSegment > segmentCount) {
    return { ok: false, code: 'RESUME_TOKEN_RANGE' };
  }

  const blobBytes = bytes[22];
  if (blobBytes > RESUME_RANGE_BLOB_BYTES) return { ok: false, code: 'RESUME_TOKEN_RANGE' };
  const missing = unpackRanges(bytes.subarray(23, 23 + blobBytes), segmentCount);
  if (!missing) return { ok: false, code: 'RESUME_TOKEN_RANGE' };

  return {
    ok: true,
    value: {
      version: bytes[0],
      sessionId: readU32(bytes, 1),
      fileId: readU32(bytes, 5),
      segmentCount,
      resumeFromSegment,
      digestPrefix: bytes.slice(17, 17 + RESUME_TOKEN_DIGEST_BYTES),
      missing,
    },
  };
}

/**
 * The segment indices a sender should generate recovery symbols for.
 *
 * A v2 token names them. A v1 token does not, so the honest reading of it is
 * "everything from the restart point onwards" — more than is needed, which is
 * the trade v1 was designed around and is stated here rather than hidden.
 */
export function resumeTokenTargets(token: TargetedResumeToken): number[] {
  if (token.missing && token.missing.length > 0) {
    const targets: number[] = [];
    for (const range of token.missing) {
      for (let index = range.start; index < range.start + range.length; index += 1) {
        targets.push(index);
      }
    }
    return targets;
  }
  const targets: number[] = [];
  for (let index = token.resumeFromSegment; index < token.segmentCount; index += 1) {
    targets.push(index);
  }
  return targets;
}
