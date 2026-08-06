import { describe, it, expect } from 'vitest';
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
  Frame
} from '../../src/core/index.js';
import { computeSha256 } from '../../src/core/hash.js';
import { compressIfBeneficial, decompress } from '../../src/core/compression.js';
import { sanitizeFilename } from '../../src/core/filename-sanitizer.js';

describe('DEQR Core Pipeline', () => {

  it('should correctly sanitize filenames', () => {
    expect(sanitizeFilename('normal.txt')).toBe('normal.txt');
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeFilename('hello\0world.pdf')).toBe('helloworld.pdf');
    expect(sanitizeFilename('  whitespace.jpg  ')).toBe('whitespace.jpg');
    expect(sanitizeFilename('<invalid>.txt')).toBe('_invalid_.txt');
  });

  it('should correctly compress and decompress data if beneficial', () => {
    const originalText = 'A'.repeat(1000); // Highly compressible
    const originalBuffer = Buffer.from(originalText, 'utf8');

    const { buffer: compressedBuffer, compressed } = compressIfBeneficial(originalBuffer);
    expect(compressed).toBe(true);
    expect(compressedBuffer.length).toBeLessThan(originalBuffer.length);

    const decompressed = decompress(compressedBuffer);
    expect(decompressed.equals(originalBuffer)).toBe(true);
  });

  it('should skip compression if not beneficial', () => {
    const randomBuffer = randomBytes(1000); // Uncompressible

    const { buffer: resultBuffer, compressed } = compressIfBeneficial(randomBuffer);
    expect(compressed).toBe(false);
    expect(resultBuffer.equals(randomBuffer)).toBe(true);
  });

  it('should compute SHA-256 correctly', () => {
    const buf = Buffer.from('hello world', 'utf8');
    const sha = computeSha256(buf);
    expect(sha.length).toBe(32);
    // B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9 for 'hello world'
    expect(sha.toString('hex')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should serialize and deserialize a DEQR container', () => {
    const payload = randomBytes(1024);
    const sha256 = computeSha256(payload);

    const original: DeqrContainer = {
      metadata: {
        protocolVersion: PROTOCOL_VERSION,
        filename: 'test.bin',
        mimeType: 'application/octet-stream',
        originalSize: payload.length,
        compressed: false,
        encrypted: false,
        timestamp: Date.now(),
        sha256
      },
      payload
    };

    const serialized = serializeContainer(original);
    const deserialized = deserializeContainer(serialized);

    expect(deserialized.metadata.filename).toBe(original.metadata.filename);
    expect(deserialized.metadata.originalSize).toBe(original.metadata.originalSize);
    expect(deserialized.metadata.sha256.equals(original.metadata.sha256)).toBe(true);
    expect(deserialized.payload.equals(original.payload)).toBe(true);
  });

  it('should encode and decode a payload using LT codes', () => {
    // We use a small file for fast testing
    const originalPayload = randomBytes(10000); // ~10KB
    const blockSize = 512;
    const sessionId = 12345;

    const encoder = new FountainEncoder(originalPayload, blockSize, sessionId);
    const blockCount = encoder.getBlockCount();
    
    // We expect to need slightly more than K frames due to LT code overhead
    const K = Math.ceil(10000 / 512); 
    expect(blockCount).toBe(K);

    const decoder = new FountainDecoder();
    
    let complete = false;
    let framesGenerated = 0;
    
    // Safety limit to prevent infinite loops if decoding fails
    const MAX_FRAMES = K * 3;

    while (!complete && framesGenerated < MAX_FRAMES) {
      const frame = encoder.nextFrame();
      
      // Serialize and deserialize frame to test protocol.ts
      const serializedFrame = serializeFrame(frame);
      const deserializedFrame = deserializeFrame(serializedFrame);
      
      complete = decoder.receiveFrame(deserializedFrame);
      framesGenerated++;
    }

    expect(complete).toBe(true);
    
    // Decode usually requires around K + O(sqrt(K)) frames, let's just make sure it's somewhat close
    expect(framesGenerated).toBeLessThan(MAX_FRAMES);

    const reconstructed = decoder.reconstructPayload();
    expect(reconstructed.equals(originalPayload)).toBe(true);
  });

  it('should be robust to frame loss and out-of-order delivery', () => {
    const originalPayload = randomBytes(50000); // 50KB
    const blockSize = 512;
    const sessionId = 9999;

    const encoder = new FountainEncoder(originalPayload, blockSize, sessionId);
    const decoder = new FountainDecoder();
    
    const frames: Frame[] = [];
    // Generate a bunch of frames (more than needed)
    for (let i = 0; i < encoder.getBlockCount() * 2; i++) {
      frames.push(encoder.nextFrame());
    }

    // Shuffle frames (out of order)
    frames.sort(() => Math.random() - 0.5);

    // Drop 30% of frames (simulating camera frame drop)
    const droppedFrames = frames.filter(() => Math.random() > 0.3);

    let complete = false;
    for (const frame of droppedFrames) {
      if (decoder.receiveFrame(frame)) {
        complete = true;
        break;
      }
    }

    // If it didn't complete, it just means we dropped too many or got unlucky, 
    // but typically 1.4 * K frames is enough. If it didn't complete, we feed more frames
    while (!complete) {
      complete = decoder.receiveFrame(encoder.nextFrame());
    }

    expect(complete).toBe(true);
    const reconstructed = decoder.reconstructPayload();
    expect(reconstructed.equals(originalPayload)).toBe(true);
  });

  it('should integrate the full loopback pipeline', () => {
    // 1. Generate original file
    const originalData = Buffer.from('Integration test data, '.repeat(500), 'utf8');
    const filename = 'data.txt';
    const mimeType = 'text/plain';

    // 2. Prepare for transfer (Hash + Compress)
    const sha256 = computeSha256(originalData);
    const { buffer: compressedPayload, compressed } = compressIfBeneficial(originalData);

    // 3. Create Container
    const containerOriginal: DeqrContainer = {
      metadata: {
        protocolVersion: PROTOCOL_VERSION,
        filename,
        mimeType,
        originalSize: originalData.length,
        compressed,
        encrypted: false,
        timestamp: Date.now(),
        sha256
      },
      payload: compressedPayload
    };
    const serializedContainer = serializeContainer(containerOriginal);

    // 4. Encode
    const blockSize = 512;
    const sessionId = 555;
    const encoder = new FountainEncoder(serializedContainer, blockSize, sessionId);
    
    // 5. Decode
    const decoder = new FountainDecoder();
    let complete = false;
    let iterations = 0;
    while (!complete && iterations < 5000) {
      complete = decoder.receiveFrame(encoder.nextFrame());
      iterations++;
    }
    expect(complete).toBe(true);

    const reconstructedContainerBytes = decoder.reconstructPayload();

    // 6. Deserialize Container
    const reconstructedContainer = deserializeContainer(reconstructedContainerBytes);

    expect(reconstructedContainer.metadata.filename).toBe(filename);
    expect(reconstructedContainer.metadata.originalSize).toBe(originalData.length);
    expect(reconstructedContainer.metadata.compressed).toBe(compressed);

    // 7. Verify Hash
    expect(reconstructedContainer.metadata.sha256.equals(sha256)).toBe(true);

    // 8. Decompress (if needed)
    const finalData = reconstructedContainer.metadata.compressed 
      ? decompress(reconstructedContainer.payload) 
      : reconstructedContainer.payload;

    expect(computeSha256(finalData).equals(sha256)).toBe(true);
    expect(finalData.equals(originalData)).toBe(true);
  });
});
