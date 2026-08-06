import { PRNG, RobustSoliton } from './prng.js';
import { Frame, FrameHeader, FRAME_PROTOCOL_VERSION } from './protocol.js';

/**
 * Luby Transform (LT) Fountain Encoder
 *
 * Encodes an arbitrary binary payload into an infinite stream of frames.
 */
export class FountainEncoder {
  private payload: Buffer;
  private blockSize: number;
  private sessionId: number;
  private blockCount: number;
  private blocks: Buffer[];
  private soliton: RobustSoliton;
  private sequenceCounter: number;

  /**
   * @param payload The entire binary payload (DEQR container).
   * @param blockSize The size of each block in bytes (e.g., 512).
   * @param sessionId A unique 32-bit ID for this transfer session.
   */
  constructor(payload: Buffer, blockSize: number, sessionId: number) {
    this.payload = payload;
    this.blockSize = blockSize;
    this.sessionId = sessionId;
    this.sequenceCounter = 0;

    // Calculate block count K
    this.blockCount = Math.ceil(payload.length / blockSize);
    if (this.blockCount === 0 || this.blockCount > 65535) {
      throw new Error(`Invalid block count K=${this.blockCount}. Must be 1-65535.`);
    }

    // Split payload into padded blocks
    this.blocks = new Array(this.blockCount);
    for (let i = 0; i < this.blockCount; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, payload.length);
      const slice = payload.subarray(start, end);
      
      if (slice.length === blockSize) {
        this.blocks[i] = slice;
      } else {
        // Pad the last block with zeros
        const padded = Buffer.alloc(blockSize, 0);
        slice.copy(padded);
        this.blocks[i] = padded;
      }
    }

    this.soliton = new RobustSoliton(this.blockCount);
  }

  /**
   * Generates the next fountain frame.
   * This can be called indefinitely to generate as many frames as needed.
   * 
   * Uses Systematic Fountain Mode:
   * Frames with sequenceNumber < blockCount (K) are emitted as degree-1 
   * original source blocks. Frames with sequenceNumber >= K are LT repair symbols.
   */
  public nextFrame(): Frame {
    const sequenceNumber = this.sequenceCounter++;
    let framePayload = Buffer.alloc(this.blockSize, 0);

    if (sequenceNumber < this.blockCount) {
      // Systematic frame: Degree 1, containing exactly block[sequenceNumber]
      const block = this.blocks[sequenceNumber];
      block.copy(framePayload);
    } else {
      // Repair frame: LT codes via Soliton distribution
      const prng = new PRNG(sequenceNumber);
      const d = this.soliton.sampleDegree(prng);
      const selectedIndices = this.selectDistinctIndices(prng, d, this.blockCount);
      
      for (const index of selectedIndices) {
        const block = this.blocks[index];
        for (let i = 0; i < this.blockSize; i++) {
          framePayload[i] ^= block[i];
        }
      }
    }

    const header: FrameHeader = {
      protocolVersion: FRAME_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      segmentNumber: 0, // M1 does not support multi-segment
      sequenceNumber,
      blockCount: this.blockCount,
      blockSize: this.blockSize,
      totalPayloadLength: this.payload.length,
    };

    return { header, payload: framePayload };
  }

  /**
   * Helper to select d distinct indices from [0, max).
   * Uses a Fisher-Yates style selection for small d or rejection sampling.
   */
  private selectDistinctIndices(prng: PRNG, d: number, max: number): number[] {
    const indices = new Set<number>();
    while (indices.size < d) {
      indices.add(prng.nextInt(0, max));
    }
    return Array.from(indices);
  }

  public getBlockCount(): number {
    return this.blockCount;
  }
}
