export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 20;
export const LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxBlockCount: 65_535,
  maxBlockSize: 2_048,
  maxFrameBytes: HEADER_SIZE + 2_048,
  maxFilenameBytes: 1_024,
  maxMimeBytes: 1_024,
  maxSeenFrames: 200_000,
} as const;

export type ErrorCode = 'INVALID_FRAME' | 'INVALID_MAGIC' | 'UNSUPPORTED_PROTOCOL' | 'INVALID_METADATA' | 'INVALID_BLOCK_INDEX' | 'CONFLICTING_DUPLICATE' | 'SESSION_MISMATCH' | 'RESOURCE_LIMIT_EXCEEDED' | 'TRANSFER_INCOMPLETE' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'UNSUPPORTED_COMPRESSION' | 'ENCRYPTED_CONTAINER';
export class DeqrProtocolError extends Error { constructor(public readonly code: ErrorCode, message: string) { super(message); } }
export interface FrameHeader { protocolVersion: number; sessionId: number; segmentNumber: number; sequenceNumber: number; blockCount: number; blockSize: number; totalPayloadLength: number; }
export interface DeqrFrame { header: FrameHeader; payload: Uint8Array; raw: Uint8Array; }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: DeqrProtocolError };
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: ErrorCode, message: string): never { throw new DeqrProtocolError(code, message); }
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function xorChecksum(bytes: Uint8Array): number { return bytes.reduce((value, byte) => value ^ byte, 0); }
function safeText(bytes: Uint8Array, name: string): string { try { return decoder.decode(bytes); } catch { return fail('INVALID_METADATA', `${name} is not valid UTF-8`); } }

export function parseFrame(raw: Uint8Array): ParseResult<DeqrFrame> {
  try {
    if (raw.length < HEADER_SIZE || raw.length > LIMITS.maxFrameBytes) fail('INVALID_FRAME', 'Frame length is outside the accepted bounds.');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (xorChecksum(raw.subarray(0, HEADER_SIZE - 1)) !== raw[HEADER_SIZE - 1]) fail('INVALID_FRAME', 'Frame header checksum does not match.');
    const header: FrameHeader = { protocolVersion: view.getUint8(0), sessionId: view.getUint32(1), segmentNumber: view.getUint16(5), sequenceNumber: view.getUint32(7), blockCount: view.getUint16(11), blockSize: view.getUint16(13), totalPayloadLength: view.getUint32(15) };
    if (header.protocolVersion !== PROTOCOL_VERSION) fail('UNSUPPORTED_PROTOCOL', `Protocol ${header.protocolVersion} is not supported.`);
    if (header.segmentNumber !== 0) fail('INVALID_FRAME', 'Multi-segment frames are not supported by protocol v1.');
    if (header.blockCount < 1 || header.blockCount > LIMITS.maxBlockCount || header.blockSize < 1 || header.blockSize > LIMITS.maxBlockSize) fail('RESOURCE_LIMIT_EXCEEDED', 'Frame block declaration exceeds receiver limits.');
    if (header.totalPayloadLength < 1 || header.totalPayloadLength > LIMITS.maxFileBytes || header.blockCount * header.blockSize < header.totalPayloadLength) fail('RESOURCE_LIMIT_EXCEEDED', 'Frame length declaration is invalid.');
    if (raw.length !== HEADER_SIZE + header.blockSize) fail('INVALID_FRAME', 'Frame payload length does not match its block size.');
    return { ok: true, value: { header, payload: raw.slice(HEADER_SIZE), raw: raw.slice() } };
  } catch (error) { return { ok: false, error: error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_FRAME', 'Frame could not be parsed.') }; }
}

export function sanitizeFilename(input: string): string {
  const base = input.replace(/[\\/]/g, '_').replace(/\.\./g, '').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  const fallback = base || 'received-file';
  if (fallback.length <= 255) return fallback;
  const dot = fallback.lastIndexOf('.'); const extension = dot > 0 ? fallback.slice(dot) : '';
  return `${fallback.slice(0, Math.max(1, 255 - extension.length))}${extension}`;
}

export interface Container { filename: string; mimeType: string; originalSize: number; compressed: boolean; encrypted: boolean; sha256: Uint8Array; payload: Uint8Array; }
export function parseContainer(bytes: Uint8Array): Container {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  const take = (length: number): Uint8Array => { if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) fail('INVALID_METADATA', 'Container is truncated.'); const output = bytes.slice(offset, offset + length); offset += length; return output; };
  if (bytes.length < 60 || safeText(take(4), 'magic') !== 'DEQR') fail('INVALID_MAGIC', 'Container magic is not DEQR.');
  const version = view.getUint16(offset); offset += 2; if (version !== PROTOCOL_VERSION) fail('UNSUPPORTED_PROTOCOL', `Container protocol ${version} is not supported.`);
  const filenameLength = view.getUint16(offset); offset += 2; if (filenameLength > LIMITS.maxFilenameBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'Filename is too long.');
  const filename = sanitizeFilename(safeText(take(filenameLength), 'filename'));
  const mimeLength = view.getUint16(offset); offset += 2; if (mimeLength > LIMITS.maxMimeBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'MIME type is too long.');
  const mimeType = safeText(take(mimeLength), 'MIME type');
  const sizeBig = view.getBigUint64(offset); offset += 8; if (sizeBig > BigInt(LIMITS.maxFileBytes)) fail('RESOURCE_LIMIT_EXCEEDED', 'Declared file is too large.');
  const originalSize = Number(sizeBig);
  const compressedFlag = view.getUint8(offset++); const encryptedFlag = view.getUint8(offset++);
  if (compressedFlag > 1 || encryptedFlag > 1) fail('INVALID_METADATA', 'Container flags are invalid.');
  take(8); const sha256 = take(32); const payload = take(bytes.length - offset);
  if (!compressedFlag && payload.length !== originalSize) fail('SIZE_MISMATCH', 'Uncompressed payload length does not match declared size.');
  return { filename, mimeType, originalSize, compressed: compressedFlag === 1, encrypted: encryptedFlag === 1, sha256, payload };
}

class Prng { private state: number; constructor(seed: number) { this.state = (seed || 0xdeadbeef) >>> 0; } next(): number { let t = (this.state += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000; } int(max: number): number { return Math.floor(this.next() * max); } }
class Soliton { private readonly cdf: number[]; constructor(private readonly k: number) { const s = 0.1 * Math.log(k / 0.05) * Math.sqrt(k); const rho = Array(k + 1).fill(0); const tau = Array(k + 1).fill(0); rho[1] = 1 / k; for (let d = 2; d <= k; d++) rho[d] = 1 / (d * (d - 1)); const limit = Math.floor(k / s); for (let d = 1; d < limit; d++) tau[d] = s / (k * d); if (limit >= 1 && limit <= k) tau[limit] = s * Math.log(s / 0.05) / k; const sum = rho.reduce((total, value, i) => total + value + tau[i], 0); let running = 0; this.cdf = Array(k + 1).fill(0); for (let d = 1; d <= k; d++) { running += (rho[d] + tau[d]) / sum; this.cdf[d] = running; } } degree(prng: Prng): number { const p = prng.next(); for (let d = 1; d <= this.k; d++) if (p <= this.cdf[d]) return d; return this.k; } }

interface Node { sequence: number; neighbors: number[]; payload: Uint8Array; }
class FountainDecoder {
  private header: FrameHeader | null = null; private soliton: Soliton | null = null; private readonly unsolved = new Map<number, Node>(); private readonly seen = new Map<number, Uint8Array>(); private blocks: Array<Uint8Array | undefined> = []; private solved = 0;
  receive(frame: DeqrFrame): 'accepted' | 'duplicate' | 'complete' {
    if (!this.header) { this.header = frame.header; this.soliton = new Soliton(frame.header.blockCount); this.blocks = Array(frame.header.blockCount); }
    else if (this.header.sessionId !== frame.header.sessionId) fail('SESSION_MISMATCH', 'Frame belongs to a different transfer.');
    else if (['blockCount', 'blockSize', 'totalPayloadLength'].some((key) => this.header![key as keyof FrameHeader] !== frame.header[key as keyof FrameHeader])) fail('INVALID_FRAME', 'Frame metadata conflicts with the active transfer.');
    const prior = this.seen.get(frame.header.sequenceNumber); if (prior) { if (!equal(prior, frame.raw)) fail('CONFLICTING_DUPLICATE', 'A sequence number was observed with different data.'); return 'duplicate'; }
    if (this.seen.size >= LIMITS.maxSeenFrames) fail('RESOURCE_LIMIT_EXCEEDED', 'Too many frames were observed for one transfer.'); this.seen.set(frame.header.sequenceNumber, frame.raw);
    const neighbors = this.neighbors(frame.header.sequenceNumber); const node: Node = { sequence: frame.header.sequenceNumber, neighbors, payload: frame.payload.slice() }; this.eliminate(node); if (node.neighbors.length) { this.unsolved.set(node.sequence, node); if (node.neighbors.length === 1) this.ripple(node); }
    return this.solved === this.blocks.length ? 'complete' : 'accepted';
  }
  private neighbors(sequence: number): number[] { if (!this.header || !this.soliton) return []; if (sequence < this.header.blockCount) return [sequence]; const prng = new Prng(sequence); const wanted = this.soliton.degree(prng); const selected = new Set<number>(); while (selected.size < wanted) selected.add(prng.int(this.header.blockCount)); return [...selected]; }
  private eliminate(node: Node): void { node.neighbors = node.neighbors.filter((index) => { const block = this.blocks[index]; if (!block) return true; for (let i = 0; i < node.payload.length; i++) node.payload[i] ^= block[i]; return false; }); }
  private ripple(initial: Node): void { const queue = [initial]; while (queue.length) { const node = queue.shift()!; if (node.neighbors.length !== 1) continue; const index = node.neighbors[0]; if (this.blocks[index]) { this.unsolved.delete(node.sequence); continue; } this.blocks[index] = node.payload.slice(); this.solved++; this.unsolved.delete(node.sequence); for (const [sequence, other] of this.unsolved) { const position = other.neighbors.indexOf(index); if (position < 0) continue; for (let i = 0; i < other.payload.length; i++) other.payload[i] ^= node.payload[i]; other.neighbors.splice(position, 1); if (other.neighbors.length === 1) queue.push(other); else if (!other.neighbors.length) this.unsolved.delete(sequence); } } }
  progress(): { solved: number; total: number } { return { solved: this.solved, total: this.blocks.length }; }
  reconstruct(): Uint8Array { if (!this.header || this.solved !== this.blocks.length) fail('TRANSFER_INCOMPLETE', 'Not all source blocks have been recovered.'); const joined = new Uint8Array(this.blocks.length * this.header.blockSize); this.blocks.forEach((block, index) => joined.set(block!, index * this.header!.blockSize)); return joined.slice(0, this.header.totalPayloadLength); }
}

export type ReceiverState = 'READY' | 'RECEIVING' | 'VERIFYING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
export interface ReceiverSnapshot { state: ReceiverState; filename?: string; receivedBlocks: number; totalBlocks: number; duplicates: number; error?: DeqrProtocolError; verified?: VerifiedFile; }
export interface VerifiedFile { filename: string; mimeType: string; bytes: Uint8Array; sha256: Uint8Array; }
export class ReceiverSession {
  private decoder = new FountainDecoder(); private state: ReceiverState = 'READY'; private duplicates = 0; private foreignFrames = 0; private activeSession?: number; private error?: DeqrProtocolError; private verified?: VerifiedFile;
  receive(raw: Uint8Array): ReceiverSnapshot { const parsed = parseFrame(raw); if (!parsed.ok) return this.failed(parsed.error); if (this.activeSession !== undefined && parsed.value.header.sessionId !== this.activeSession) { this.foreignFrames++; return this.snapshot(); } this.activeSession ??= parsed.value.header.sessionId; try { const outcome = this.decoder.receive(parsed.value); if (outcome === 'duplicate') this.duplicates++; this.state = outcome === 'complete' ? 'VERIFYING' : 'RECEIVING'; return this.snapshot(); } catch (error) { return this.failed(error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_FRAME', 'Receiver rejected frame.')); } }
  async verify(): Promise<ReceiverSnapshot> { if (this.state !== 'VERIFYING') return this.snapshot(); try { const container = parseContainer(this.decoder.reconstruct()); if (container.encrypted) fail('ENCRYPTED_CONTAINER', 'Encrypted payloads are not supported by protocol v1 receiver.'); const bytes = container.compressed ? await inflateGzip(container.payload, container.originalSize) : container.payload; if (bytes.length !== container.originalSize) fail('SIZE_MISMATCH', 'Reconstructed file size does not match declared size.'); const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)); if (!equal(hash, container.sha256)) fail('HASH_MISMATCH', 'SHA-256 verification failed.'); this.verified = { filename: container.filename, mimeType: container.mimeType || 'application/octet-stream', bytes, sha256: hash }; this.state = 'COMPLETE'; return this.snapshot(); } catch (error) { return this.failed(error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_METADATA', 'Container verification failed.')); } }
  cancel(): ReceiverSnapshot { this.clear(); this.state = 'CANCELLED'; return this.snapshot(); }
  reset(): ReceiverSnapshot { this.clear(); this.state = 'READY'; return this.snapshot(); }
  private clear(): void { this.decoder = new FountainDecoder(); this.duplicates = 0; this.foreignFrames = 0; this.activeSession = undefined; this.error = undefined; this.verified = undefined; }
  private failed(error: DeqrProtocolError): ReceiverSnapshot { this.error = error; this.state = 'FAILED'; return this.snapshot(); }
  snapshot(): ReceiverSnapshot { const progress = this.decoder.progress(); return { state: this.state, filename: this.verified?.filename, receivedBlocks: progress.solved, totalBlocks: progress.total, duplicates: this.duplicates, error: this.error, verified: this.verified }; }
}

async function inflateGzip(payload: Uint8Array, expectedSize: number): Promise<Uint8Array> { if (!('DecompressionStream' in globalThis)) fail('UNSUPPORTED_COMPRESSION', 'This browser cannot safely decompress gzip DEQR payloads.'); const stream = new Blob([Uint8Array.from(payload).buffer]).stream().pipeThrough(new DecompressionStream('gzip')); const bytes = new Uint8Array(await new Response(stream).arrayBuffer()); if (bytes.length > expectedSize) fail('SIZE_MISMATCH', 'Decompressed payload exceeded its declared size.'); return bytes; }
