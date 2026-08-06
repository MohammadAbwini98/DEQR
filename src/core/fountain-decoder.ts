import { PRNG, RobustSoliton } from './prng.js';
import { Frame } from './protocol.js';
import { MAX_FILE_SIZE } from './container.js';

interface DecoderNode {
  sequenceNumber: number;
  degree: number;
  neighbors: number[];      // Indices of source blocks this frame depends on
  payload: Buffer;          // The current XOR sum
}

/**
 * Luby Transform (LT) Fountain Decoder
 *
 * Reconstructs the original binary payload from a stream of fountain frames.
 * Uses a Belief Propagation / Ripple algorithm.
 */
export class FountainDecoder {
  private sessionId: number = -1;
  private blockCount: number = -1;
  private blockSize: number = -1;
  private totalPayloadLength: number = -1;
  private soliton: RobustSoliton | null = null;
  
  // State
  private frames: Map<number, DecoderNode> = new Map(); // Unsolved frames
  private decodedBlocks: Buffer[] = [];                 // Solved blocks
  private solvedCount: number = 0;                      // Number of solved blocks
  private isComplete: boolean = false;                  // True when all blocks are solved

  constructor() {}

  /**
   * Process a received frame.
   * Returns true if this frame caused the decoding to complete.
   */
  public receiveFrame(frame: Frame): boolean {
    if (this.isComplete) {
      return true;
    }

    const { header, payload } = frame;

    // Initialize session parameters on first valid frame
    if (this.sessionId === -1) {
      if (header.totalPayloadLength > MAX_FILE_SIZE) {
        throw new Error(`Payload length ${header.totalPayloadLength} exceeds maximum allowed (${MAX_FILE_SIZE} bytes)`);
      }
      if (header.blockCount * header.blockSize > MAX_FILE_SIZE + header.blockSize) {
        throw new Error('Block parameters exceed maximum allowed memory bounds');
      }

      this.sessionId = header.sessionId;
      this.blockCount = header.blockCount;
      this.blockSize = header.blockSize;
      this.totalPayloadLength = header.totalPayloadLength;
      this.decodedBlocks = new Array(this.blockCount).fill(null);
      this.soliton = new RobustSoliton(this.blockCount);
    } else {
      // Validate consistency
      if (
        this.sessionId !== header.sessionId ||
        this.blockCount !== header.blockCount ||
        this.blockSize !== header.blockSize ||
        this.totalPayloadLength !== header.totalPayloadLength
      ) {
        throw new Error('Inconsistent frame metadata received for current session');
      }
    }

    // Ignore duplicates
    if (this.frames.has(header.sequenceNumber)) {
      return false;
    }

    // Determine the neighbors (block indices) for this frame
    let d: number;
    let neighbors: number[];

    if (header.sequenceNumber < this.blockCount) {
      // Systematic frame: exactly matches block[sequenceNumber]
      d = 1;
      neighbors = [header.sequenceNumber];
    } else {
      // Repair frame: use PRNG and Soliton distribution
      const prng = new PRNG(header.sequenceNumber);
      d = this.soliton!.sampleDegree(prng);
      neighbors = this.selectDistinctIndices(prng, d, this.blockCount);
    }

    // Create the node
    let node: DecoderNode = {
      sequenceNumber: header.sequenceNumber,
      degree: d,
      neighbors: neighbors,
      payload: Buffer.from(payload), // copy
    };

    // Eliminate already solved blocks from this node's neighbors
    node = this.eliminateSolvedBlocks(node);

    // If it's already fully solved (degree 0 and we already had it), ignore
    if (node.degree === 0) {
      return false;
    }

    // Add to unsolved frames graph
    this.frames.set(header.sequenceNumber, node);

    // If this node is degree 1, we can solve a block and trigger the ripple effect
    if (node.degree === 1) {
      this.processRipple(node);
    }

    return this.isComplete;
  }

  /**
   * Remove already solved blocks from a new node.
   */
  private eliminateSolvedBlocks(node: DecoderNode): DecoderNode {
    const remainingNeighbors: number[] = [];
    for (const neighbor of node.neighbors) {
      if (this.decodedBlocks[neighbor]) {
        // Block is already known, XOR it out
        const block = this.decodedBlocks[neighbor];
        for (let i = 0; i < this.blockSize; i++) {
          node.payload[i] ^= block[i];
        }
      } else {
        remainingNeighbors.push(neighbor);
      }
    }
    node.neighbors = remainingNeighbors;
    node.degree = remainingNeighbors.length;
    return node;
  }

  /**
   * The belief propagation ripple effect.
   * When a block is solved, XOR it out of all other unsolved frames.
   */
  private processRipple(initialNode: DecoderNode) {
    const queue: DecoderNode[] = [initialNode];

    while (queue.length > 0) {
      const node = queue.shift()!;
      
      // Safety check: is it still degree 1?
      if (node.degree !== 1) continue;
      
      const blockIndex = node.neighbors[0];
      
      // If we somehow already solved this block, skip
      if (this.decodedBlocks[blockIndex]) {
        this.frames.delete(node.sequenceNumber);
        continue;
      }

      // 1. Solve the block
      this.decodedBlocks[blockIndex] = Buffer.from(node.payload);
      this.solvedCount++;
      
      // Remove from unsolved frames
      this.frames.delete(node.sequenceNumber);

      if (this.solvedCount === this.blockCount) {
        this.isComplete = true;
        return; // We're done!
      }

      // 2. Ripple to other frames
      // Find all frames that depend on this newly solved block
      for (const [seq, otherNode] of this.frames.entries()) {
        const neighborIdx = otherNode.neighbors.indexOf(blockIndex);
        if (neighborIdx !== -1) {
          // XOR the solved block out of the frame
          for (let i = 0; i < this.blockSize; i++) {
            otherNode.payload[i] ^= node.payload[i];
          }
          
          // Remove the neighbor
          otherNode.neighbors.splice(neighborIdx, 1);
          otherNode.degree--;

          // If the frame becomes degree 1, add it to the ripple queue
          if (otherNode.degree === 1) {
            queue.push(otherNode);
          } else if (otherNode.degree === 0) {
            // Frame is fully solved, but we already have all its blocks
            this.frames.delete(seq);
          }
        }
      }
    }
  }

  /**
   * Reconstruct the final original payload buffer.
   * Throws if decoding is not yet complete.
   */
  public reconstructPayload(): Buffer {
    if (!this.isComplete) {
      throw new Error(`Cannot reconstruct payload: missing ${this.blockCount - this.solvedCount} blocks`);
    }

    const fullBuffer = Buffer.concat(this.decodedBlocks);
    
    // Trim any padding from the last block using the original totalPayloadLength
    return fullBuffer.subarray(0, this.totalPayloadLength);
  }

  public getProgress(): number {
    if (this.blockCount === -1) return 0;
    return this.solvedCount / this.blockCount;
  }

  public getSolvedCount(): number {
    return this.solvedCount;
  }

  public getBlockCount(): number {
    return this.blockCount;
  }

  private selectDistinctIndices(prng: PRNG, d: number, max: number): number[] {
    const indices = new Set<number>();
    while (indices.size < d) {
      indices.add(prng.nextInt(0, max));
    }
    return Array.from(indices);
  }
}
