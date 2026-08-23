import { describe, expect, it } from 'vitest';

import { crc32 } from '../../src/core/crc32';
import {
  RESUME_TOKEN_BYTES,
  RESUME_TOKEN_CHARS,
  RESUME_TOKEN_DIGEST_BYTES,
  RESUME_TOKEN_VERSION,
  decodeResumeToken,
  encodeResumeToken,
  encodeResumeTokenBytes,
  resumeTokenMatchesDigest,
} from '../../src/core/resume-token';

/**
 * The token is the only channel that runs against the direction of the link,
 * and a person is the transport. So the tests here are about two things and
 * nothing else.
 *
 * **It survives being read off a screen and typed into a keyboard.** Case,
 * separators, and the three character confusions Crockford exists to absorb.
 *
 * **It refuses everything it should.** A typo, a truncation, an unknown
 * version, a resume point past the end. Each of those has to come back as its
 * own code, because a desktop that says "that code is wrong" when the real
 * answer is "that code is for another file" sends the user to retype something
 * they typed correctly.
 */

const DIGEST = Uint8Array.from({ length: 32 }, (_unused, index) => (index * 7 + 11) & 0xff);

function sample(overrides: Partial<Parameters<typeof encodeResumeToken>[0]> = {}) {
  return {
    sessionId: 0x5eed_0007,
    fileId: 0x0a0b_0c0d,
    segmentCount: 1_842,
    resumeFromSegment: 917,
    sha256: DIGEST,
    ...overrides,
  };
}

describe('the resume token round trip', () => {
  it('reads back exactly what was written', () => {
    const decoded = decodeResumeToken(encodeResumeToken(sample()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.version).toBe(RESUME_TOKEN_VERSION);
    expect(decoded.value.sessionId).toBe(0x5eed_0007);
    expect(decoded.value.fileId).toBe(0x0a0b_0c0d);
    expect(decoded.value.segmentCount).toBe(1_842);
    expect(decoded.value.resumeFromSegment).toBe(917);
    expect([...decoded.value.digestPrefix]).toEqual([...DIGEST.subarray(0, RESUME_TOKEN_DIGEST_BYTES)]);
  });

  it('is exactly forty characters, which is what makes it typable', () => {
    const raw = encodeResumeToken(sample(), false);
    expect(raw).toHaveLength(RESUME_TOKEN_CHARS);
    // Eight groups of five, and no padding character anywhere: 25 bytes is 200
    // bits, which divides by five with nothing left over.
    expect(encodeResumeToken(sample()).split('-')).toHaveLength(8);
    expect(raw).not.toContain('=');
  });

  it('holds the whole u32 range at both ends', () => {
    const extreme = sample({
      sessionId: 0xffff_ffff,
      fileId: 0,
      segmentCount: 0xffff_ffff,
      resumeFromSegment: 0xffff_fffe,
    });
    const decoded = decodeResumeToken(encodeResumeToken(extreme));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.sessionId).toBe(0xffff_ffff);
    expect(decoded.value.fileId).toBe(0);
    expect(decoded.value.segmentCount).toBe(0xffff_ffff);
    expect(decoded.value.resumeFromSegment).toBe(0xffff_fffe);
  });

  it('accepts a resume point equal to the segment count', () => {
    // Which means "every segment is here, nothing left to send". A receiver
    // that finished receiving and died before verifying still needs a token.
    const decoded = decodeResumeToken(encodeResumeToken(sample({ resumeFromSegment: 1_842 })));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.resumeFromSegment).toBe(1_842);
  });

  it('packs its 25 bytes in the documented order', () => {
    const bytes = encodeResumeTokenBytes(sample());
    expect(bytes).toHaveLength(RESUME_TOKEN_BYTES);
    expect(bytes[0]).toBe(RESUME_TOKEN_VERSION);
    expect((bytes[1] << 24 >>> 0) + (bytes[2] << 16) + (bytes[3] << 8) + bytes[4]).toBe(0x5eed_0007);
    expect([...bytes.subarray(17, 22)]).toEqual([...DIGEST.subarray(0, 5)]);
    // The checksum covers the payload and not itself.
    const checksum = crc32(bytes, 0, 22) & 0xff_ffff;
    expect((bytes[22] << 16) | (bytes[23] << 8) | bytes[24]).toBe(checksum);
  });
});

describe('the token survives a human', () => {
  it('ignores case', () => {
    const token = encodeResumeToken(sample());
    const decoded = decodeResumeToken(token.toLowerCase());
    expect(decoded.ok).toBe(true);
  });

  it('ignores separators, present, absent, or invented', () => {
    const raw = encodeResumeToken(sample(), false);
    const grouped = encodeResumeToken(sample());
    const spaced = raw.replace(/(.{4})/g, '$1 ').trim();
    for (const form of [raw, grouped, spaced, `  ${grouped}  `]) {
      expect(decodeResumeToken(form).ok).toBe(true);
    }
  });

  it('folds the three characters people actually mistype', () => {
    // Crockford leaves I, L and O out of the alphabet precisely because they
    // are read as 1, 1 and 0. A reader that rejected them would be refusing the
    // most likely correct transcription of its own output.
    const raw = encodeResumeToken(sample({ sessionId: 0x0000_0001, resumeFromSegment: 0 }), false);
    const expected = decodeResumeToken(raw);
    expect(expected.ok).toBe(true);

    const withConfusions = raw.replace(/1/g, 'I').replace(/0/g, 'O');
    const folded = decodeResumeToken(withConfusions);
    expect(folded.ok).toBe(true);
    if (!folded.ok || !expected.ok) return;
    expect(folded.value.sessionId).toBe(expected.value.sessionId);
    expect(folded.value.segmentCount).toBe(expected.value.segmentCount);
  });
});

describe('the token refuses, and says which refusal', () => {
  it('rejects a wrong length before anything else', () => {
    const raw = encodeResumeToken(sample(), false);
    expect(decodeResumeToken(raw.slice(0, 39))).toEqual({ ok: false, code: 'RESUME_TOKEN_LENGTH' });
    expect(decodeResumeToken(`${raw}A`)).toEqual({ ok: false, code: 'RESUME_TOKEN_LENGTH' });
    expect(decodeResumeToken('')).toEqual({ ok: false, code: 'RESUME_TOKEN_LENGTH' });
  });

  it('rejects a character outside the alphabet', () => {
    const raw = encodeResumeToken(sample(), false);
    // `U` is deliberately not in Crockford's alphabet and is deliberately not
    // folded onto anything, so it is the clean case for a charset rejection.
    expect(decodeResumeToken(`U${raw.slice(1)}`)).toEqual({ ok: false, code: 'RESUME_TOKEN_CHARSET' });
    expect(decodeResumeToken(`${raw.slice(0, 39)}*`)).toEqual({ ok: false, code: 'RESUME_TOKEN_CHARSET' });
  });

  it('catches every single-character substitution', () => {
    // The checksum's whole job. A token differing by one character must not
    // decode to a *different valid token*, because that would send a sender to
    // the wrong segment of the right file with no warning at all.
    const raw = encodeResumeToken(sample(), false);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let checked = 0;
    for (let position = 0; position < raw.length; position += 1) {
      for (const character of alphabet) {
        if (character === raw[position]) continue;
        const mutated = `${raw.slice(0, position)}${character}${raw.slice(position + 1)}`;
        const decoded = decodeResumeToken(mutated);
        expect(decoded.ok).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(40 * 31);
  });

  it('reports a bad checksum as a typo rather than as a version problem', () => {
    const raw = encodeResumeToken(sample(), false);
    // Mutating the first character changes the version field *and* breaks the
    // checksum. The user's action is to retype, so that is what they are told.
    const mutated = `${raw[0] === 'A' ? 'B' : 'A'}${raw.slice(1)}`;
    expect(decodeResumeToken(mutated)).toEqual({ ok: false, code: 'RESUME_TOKEN_CHECKSUM' });
  });

  it('reports an unknown version when the checksum is intact', () => {
    const bytes = encodeResumeTokenBytes(sample());
    bytes[0] = RESUME_TOKEN_VERSION + 1;
    const checksum = crc32(bytes, 0, 22);
    bytes[22] = (checksum >>> 16) & 0xff;
    bytes[23] = (checksum >>> 8) & 0xff;
    bytes[24] = checksum & 0xff;
    expect(decodeResumeToken(toBase32(bytes))).toEqual({ ok: false, code: 'RESUME_TOKEN_VERSION' });
  });

  it('rejects a resume point past the end of its own plan', () => {
    const bytes = encodeResumeTokenBytes(sample({ segmentCount: 10, resumeFromSegment: 10 }));
    // 11 of 10 segments: structurally sound, and describes nothing.
    bytes[16] = 11;
    const checksum = crc32(bytes, 0, 22);
    bytes[22] = (checksum >>> 16) & 0xff;
    bytes[23] = (checksum >>> 8) & 0xff;
    bytes[24] = checksum & 0xff;
    expect(decodeResumeToken(toBase32(bytes))).toEqual({ ok: false, code: 'RESUME_TOKEN_RANGE' });
  });

  it('refuses to encode fields it cannot represent', () => {
    expect(() => encodeResumeToken(sample({ segmentCount: 0 }))).toThrow(RangeError);
    expect(() => encodeResumeToken(sample({ resumeFromSegment: 1_843 }))).toThrow(RangeError);
    expect(() => encodeResumeToken(sample({ sessionId: -1 }))).toThrow(RangeError);
    expect(() => encodeResumeToken(sample({ sessionId: 2 ** 32 }))).toThrow(RangeError);
    expect(() => encodeResumeToken(sample({ sha256: new Uint8Array(4) }))).toThrow(RangeError);
  });
});

describe('the digest prefix binds a token to a file', () => {
  it('matches the digest it was made from', () => {
    const decoded = decodeResumeToken(encodeResumeToken(sample()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(resumeTokenMatchesDigest(decoded.value, DIGEST)).toBe(true);
  });

  it('rejects a file that differs anywhere in the carried prefix', () => {
    const decoded = decodeResumeToken(encodeResumeToken(sample()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    for (let index = 0; index < RESUME_TOKEN_DIGEST_BYTES; index += 1) {
      const other = DIGEST.slice();
      other[index] ^= 0x01;
      expect(resumeTokenMatchesDigest(decoded.value, other)).toBe(false);
    }
  });

  it('is honest about what it does not check', () => {
    const decoded = decodeResumeToken(encodeResumeToken(sample()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // Bytes past the prefix are not carried and cannot be checked here. That is
    // the documented limit of the token, and the reason SHA-256 over the whole
    // reconstruction remains the only authority on file identity.
    const differsLater = DIGEST.slice();
    differsLater[RESUME_TOKEN_DIGEST_BYTES] ^= 0xff;
    expect(resumeTokenMatchesDigest(decoded.value, differsLater)).toBe(true);
  });

  it('refuses a digest too short to compare', () => {
    const decoded = decodeResumeToken(encodeResumeToken(sample()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(resumeTokenMatchesDigest(decoded.value, new Uint8Array(4))).toBe(false);
  });
});

/** Crockford base32 over whole bytes. Mirrors the encoder, for mutation tests. */
function toBase32(bytes: Uint8Array): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let output = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >>> bits) & 0x1f];
    }
  }
  return output;
}
