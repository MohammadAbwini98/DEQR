import { describe, it, expect } from 'vitest';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { FountainDecoder } from '../../src/core/fountain-decoder';
import { serializeContainer, deserializeContainer } from '../../src/core/container';
import { computeSha256 } from '../../src/core/hash';
import { serializeFrame, deserializeFrame } from '../../src/core/protocol';
import { PRNG } from '../../src/core/prng';

describe('Multi-Frame Reassembly', () => {
  it('correctly reassembles a file across multiple frames and validates hash with randomized drops and duplicates', () => {
    const originalFile = Buffer.alloc(10000, 0x42); 
    
    const hash = computeSha256(originalFile);
    const containerBuffer = serializeContainer({
      metadata: {
        protocolVersion: 1,
        filename: 'test.txt',
        mimeType: 'text/plain',
        originalSize: originalFile.length,
        compressed: false,
        encrypted: false,
        timestamp: Date.now(),
        sha256: hash
      },
      payload: originalFile
    });

    const encoder = new FountainEncoder(containerBuffer, 512, 12345);
    const decoder = new FountainDecoder();

    let frames = [];
    for (let i = 0; i < 50; i++) {
      frames.push(encoder.nextFrame());
    }

    // Shuffle frames deterministically
    const prng = new PRNG(42);
    for (let i = frames.length - 1; i > 0; i--) {
      const j = prng.nextInt(0, i + 1);
      [frames[i], frames[j]] = [frames[j], frames[i]];
    }

    // Duplicate some frames
    frames.splice(10, 0, frames[5]);
    frames.splice(20, 0, frames[15]);

    // Drop some frames
    frames = frames.filter((_, idx) => idx % 5 !== 0);

    let isComplete = false;
    for (const frame of frames) {
      const serialized = serializeFrame(frame);
      const deserialized = deserializeFrame(serialized);
      isComplete = decoder.receiveFrame(deserialized);
      if (isComplete) break;
    }

    // Keep generating if not complete
    while (!isComplete) {
      const frame = encoder.nextFrame();
      const serialized = serializeFrame(frame);
      const deserialized = deserializeFrame(serialized);
      isComplete = decoder.receiveFrame(deserialized);
    }

    expect(isComplete).toBe(true);

    const reconstructedContainerBuffer = decoder.reconstructPayload();
    expect(reconstructedContainerBuffer.equals(containerBuffer)).toBe(true);

    const parsedContainer = deserializeContainer(reconstructedContainerBuffer);
    const actualHash = computeSha256(parsedContainer.payload);
    
    expect(actualHash.equals(parsedContainer.metadata.sha256)).toBe(true);
    expect(parsedContainer.payload.equals(originalFile)).toBe(true);
  });

  it('rejects frames from an interleaved session', () => {
    const originalFile1 = Buffer.alloc(1000, 0x11); 
    const containerBuffer1 = serializeContainer({
      metadata: { protocolVersion: 1, filename: 'test1.txt', mimeType: 'text/plain', originalSize: 1000, compressed: false, encrypted: false, timestamp: 0, sha256: computeSha256(originalFile1) },
      payload: originalFile1
    });

    const originalFile2 = Buffer.alloc(1000, 0x22); 
    const containerBuffer2 = serializeContainer({
      metadata: { protocolVersion: 1, filename: 'test2.txt', mimeType: 'text/plain', originalSize: 1000, compressed: false, encrypted: false, timestamp: 0, sha256: computeSha256(originalFile2) },
      payload: originalFile2
    });

    const encoder1 = new FountainEncoder(containerBuffer1, 512, 111);
    const encoder2 = new FountainEncoder(containerBuffer2, 512, 222);
    
    const decoder = new FountainDecoder();

    // First frame establishes session
    decoder.receiveFrame(deserializeFrame(serializeFrame(encoder1.nextFrame())));
    
    // Attempting to receive a frame from a different session should throw
    expect(() => {
      decoder.receiveFrame(deserializeFrame(serializeFrame(encoder2.nextFrame())));
    }).toThrow('Inconsistent frame metadata received for current session');
  });

  it('ignores duplicate frames silently', () => {
    const originalFile = Buffer.alloc(1000, 0x11); 
    const containerBuffer = serializeContainer({
      metadata: { protocolVersion: 1, filename: 'test1.txt', mimeType: 'text/plain', originalSize: 1000, compressed: false, encrypted: false, timestamp: 0, sha256: computeSha256(originalFile) },
      payload: originalFile
    });
    
    const encoder = new FountainEncoder(containerBuffer, 512, 111);
    const decoder = new FountainDecoder();

    const frame1 = encoder.nextFrame();
    
    const deserialized1 = deserializeFrame(serializeFrame(frame1));
    decoder.receiveFrame(deserialized1);
    const solvedBefore = decoder.getSolvedCount();

    // Send the exact same frame again
    const deserialized2 = deserializeFrame(serializeFrame(frame1));
    const isComplete = decoder.receiveFrame(deserialized2);

    expect(decoder.getSolvedCount()).toBe(solvedBefore); // Count should not increase
    expect(isComplete).toBe(false);
  });
});
