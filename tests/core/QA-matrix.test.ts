import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'crypto';
import {
  serializeContainer,
  deserializeContainer,
  DeqrContainer,
  PROTOCOL_VERSION
} from '../../src/core/container.js';
import {
  FountainEncoder,
  FountainDecoder,
  serializeFrame,
  deserializeFrame,
  FrameHeader,
  FRAME_PROTOCOL_VERSION,
  HEADER_SIZE,
  calculateChecksum
} from '../../src/core/index.js';
import { computeSha256 } from '../../src/core/hash.js';
import { compressIfBeneficial, decompress } from '../../src/core/compression.js';
import { sanitizeFilename, isBlockedExtension } from '../../src/core/filename-sanitizer.js';

describe('QA Matrix: Security - Filename Handling', () => {
  it('Safe filename construction', () => {
    // Basic sanitization
    expect(sanitizeFilename('../file.txt')).toBe('file.txt');
    expect(sanitizeFilename('..\\file.txt')).toBe('file.txt');
    expect(sanitizeFilename('CON.txt')).toBe('CON.txt'); // Handled safely by OS if not raw CON
    expect(sanitizeFilename('name:stream.txt')).toBe('name_stream.txt');
    expect(sanitizeFilename('file.exe ')).toBe('file.exe');
    expect(sanitizeFilename('file.exe.')).toBe('file.exe');
    expect(sanitizeFilename('  ')).toBe('unnamed');
    expect(sanitizeFilename('')).toBe('unnamed');
    expect(sanitizeFilename('\0file.txt')).toBe('file.txt');
    // Long filename truncated safely
    const longName = 'A'.repeat(300) + '.txt';
    expect(sanitizeFilename(longName).length).toBe(255);
    expect(sanitizeFilename(longName).endsWith('.txt')).toBe(true);
  });

  it('Extension blocking enforcement', () => {
    expect(isBlockedExtension('.exe')).toBe(true); // Bug ID-001 fixed
    expect(isBlockedExtension('.EXE')).toBe(true);
    expect(isBlockedExtension('file.exe')).toBe(true);
    expect(isBlockedExtension('file.exe.txt')).toBe(false); // Valid: opens as text
    expect(isBlockedExtension('file.txt.exe')).toBe(true); // Valid: opens as executable
    expect(isBlockedExtension('file.bat')).toBe(true);
    expect(isBlockedExtension('file.cmd')).toBe(true);
    expect(isBlockedExtension('file.js')).toBe(true);
  });
});

describe('QA Matrix: Security - Decompression Controls', () => {
  it('Decompression bombs are blocked by size limit', () => {
    // Generate a highly compressible 1MB buffer
    const buf = Buffer.alloc(1024 * 1024, 'A');
    const { buffer: compressed } = compressIfBeneficial(buf);
    
    // Attempt to decompress with a malicious expected size (smaller than actual)
    // zlib throws an error when output exceeds maxOutputLength
    expect(() => decompress(compressed, 1024)).toThrow();
  });
});

describe('QA Matrix: Security - Decoder Allocations', () => {
  it('Rejects malicious block parameters (OOM DoS)', () => {
    const frame = {
      header: {
        protocolVersion: FRAME_PROTOCOL_VERSION,
        sessionId: 1,
        segmentNumber: 0,
        sequenceNumber: 1,
        blockCount: 65535,
        blockSize: 65535, // 65535 * 65535 = ~4.2GB
        totalPayloadLength: 64 * 1024 * 1024 + 1
      },
      payload: Buffer.alloc(512)
    };
    
    const decoder = new FountainDecoder();
    expect(() => decoder.receiveFrame(frame)).toThrow(/exceeds maximum allowed/);
  });
});

describe('QA Matrix: Fountain pipeline deterministic stress matrix', () => {
  // 1 through 16 block counts (Small K cases)
  for (let K = 1; K <= 16; K++) {
    it(`Systematic LT recovery for K=${K} with 0% loss (Ordered)`, () => {
      const payload = randomBytes(K * 512); // Exact blocks
      const encoder = new FountainEncoder(payload, 512, 1);
      const decoder = new FountainDecoder();
      
      let complete = false;
      for (let i = 0; i < K; i++) { // Generate exactly K frames
        complete = decoder.receiveFrame(encoder.nextFrame());
      }
      expect(complete).toBe(true);
      expect(decoder.reconstructPayload().equals(payload)).toBe(true);
    });
    
    it(`Systematic LT recovery for K=${K} with 0% loss (Shuffled)`, () => {
      const payload = randomBytes(K * 512);
      const encoder = new FountainEncoder(payload, 512, 1);
      const decoder = new FountainDecoder();
      
      const frames = [];
      for (let i = 0; i < K; i++) {
        frames.push(encoder.nextFrame());
      }
      frames.reverse(); // Shuffled
      
      let complete = false;
      for (const frame of frames) {
        complete = decoder.receiveFrame(frame);
      }
      expect(complete).toBe(true);
    });

    it(`LT recovery for K=${K} with 30% loss`, () => {
      const payload = randomBytes(K * 512);
      const encoder = new FountainEncoder(payload, 512, 1);
      const decoder = new FountainDecoder();
      
      let complete = false;
      let generated = 0;
      let received = 0;
      
      while (!complete && generated < K * 10 + 100) { // Limit to prevent infinite loop
        const frame = encoder.nextFrame();
        generated++;
        
        // Drop ~30% deterministically
        if (generated % 3 === 0) continue;
        
        received++;
        complete = decoder.receiveFrame(frame);
      }
      
      expect(complete).toBe(true);
    });
  }

  // Representative larger payloads
  const payloadSizes = [1, 1024, 16 * 1024, 256 * 1024, 1024 * 1024, 1000]; // 1B, 1KB, 16KB, 256KB, 1MB, unaligned
  const seeds = [100, 200, 300, 400, 500];

  for (const size of payloadSizes) {
    for (const seed of seeds) {
      it(`Recovers size=${size} with seed=${seed} and 30% loss`, () => {
        const payload = randomBytes(size);
        const encoder = new FountainEncoder(payload, 512, seed);
        const decoder = new FountainDecoder();
        
        const K = encoder.getBlockCount();
        
        // Deterministic PRNG for drops
        let rngState = seed;
        const nextRand = () => {
          rngState = (rngState * 1664525 + 1013904223) >>> 0;
          return rngState / 4294967296;
        };

        let complete = false;
        let generated = 0;
        
        while (!complete && generated < K * 10 + 100) {
          const frame = encoder.nextFrame();
          generated++;
          
          // Drop 30% deterministically
          if (nextRand() < 0.3) continue;
          
          complete = decoder.receiveFrame(frame);
        }

        expect(complete).toBe(true);
        if (complete) {
          const reconstructed = decoder.reconstructPayload();
          expect(reconstructed.equals(payload)).toBe(true);
        }
      });
    }
  }

  it('Fails safely on insufficient data', () => {
    const payload = randomBytes(10000);
    const encoder = new FountainEncoder(payload, 512, 1);
    const decoder = new FountainDecoder();
    
    // Only give it 1 frame (needs ~20)
    decoder.receiveFrame(encoder.nextFrame());
    
    expect(() => decoder.reconstructPayload()).toThrow(/Cannot reconstruct payload: missing/);
  });
});
