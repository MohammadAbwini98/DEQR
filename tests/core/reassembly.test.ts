import { describe, it, expect } from 'vitest';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { FountainDecoder } from '../../src/core/fountain-decoder';
import { serializeContainer, deserializeContainer } from '../../src/core/container';
import { computeSha256 } from '../../src/core/hash';
import { serializeFrame, deserializeFrame } from '../../src/core/protocol';

describe('Multi-Frame Reassembly', () => {
  it('correctly reassembles a file across multiple frames and validates hash', () => {
    // 1. Create a dummy payload
    const originalFile = Buffer.alloc(10000, 0x42); // 10KB of 0x42
    
    // 2. Create the DEQR container
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

    // 3. Encode into frames
    const encoder = new FountainEncoder(containerBuffer, 512, 12345);
    const decoder = new FountainDecoder();

    let isComplete = false;
    let framesGenerated = 0;

    // Simulate transfer with missing frames and out of order
    const frames = [];
    for (let i = 0; i < 50; i++) {
      frames.push(encoder.nextFrame());
    }

    // Shuffle and drop some
    const receivedFrames = frames.slice(5, 45).reverse();

    for (const frame of receivedFrames) {
      framesGenerated++;
      const serialized = serializeFrame(frame);
      
      // Simulating receiver process
      const deserialized = deserializeFrame(serialized);
      isComplete = decoder.receiveFrame(deserialized);
      if (isComplete) break;
    }

    // If not complete, get more frames until it is
    while (!isComplete) {
      framesGenerated++;
      const frame = encoder.nextFrame();
      const serialized = serializeFrame(frame);
      const deserialized = deserializeFrame(serialized);
      isComplete = decoder.receiveFrame(deserialized);
    }

    expect(isComplete).toBe(true);

    // 4. Reconstruct container
    const reconstructedContainerBuffer = decoder.reconstructPayload();
    expect(reconstructedContainerBuffer.equals(containerBuffer)).toBe(true);

    // 5. Native Save Boundary Simulation
    const parsedContainer = deserializeContainer(reconstructedContainerBuffer);
    const actualHash = computeSha256(parsedContainer.payload);
    
    expect(actualHash.equals(parsedContainer.metadata.sha256)).toBe(true);
    expect(parsedContainer.payload.equals(originalFile)).toBe(true);
    expect(parsedContainer.metadata.filename).toBe('test.txt');
  });
});
