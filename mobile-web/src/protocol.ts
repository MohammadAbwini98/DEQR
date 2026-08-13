export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 20;

/** Camera-originated data must not set the receiver's memory budget. */
export const LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxBlockCount: 65_535,
  maxBlockSize: 2_048,
  maxFrameBytes: HEADER_SIZE + 2_048,
  maxFilenameBytes: 1_024,
  maxMimeBytes: 1_024,
  maxSeenFrames: 131_072,
  maxUnsolvedBytes: 16 * 1024 * 1024,
} as const;

export type ErrorCode = 'INVALID_FRAME' | 'INVALID_MAGIC' | 'UNSUPPORTED_PROTOCOL' | 'INVALID_METADATA' | 'INVALID_BLOCK_INDEX' | 'CONFLICTING_DUPLICATE' | 'SESSION_MISMATCH' | 'RESOURCE_LIMIT_EXCEEDED' | 'TRANSFER_INCOMPLETE' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'UNSUPPORTED_COMPRESSION' | 'ENCRYPTED_CONTAINER' | 'FILE_TYPE_BLOCKED';
export class DeqrProtocolError extends Error { constructor(public readonly code: ErrorCode, message: string) { super(message); } }
export interface FrameHeader { protocolVersion: number; sessionId: number; segmentNumber: number; sequenceNumber: number; blockCount: number; blockSize: number; totalPayloadLength: number; }
export interface DeqrFrame { header: FrameHeader; payload: Uint8Array; raw: Uint8Array; fingerprint: number; }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: DeqrProtocolError };

const decoder = new TextDecoder('utf-8', { fatal: true });
const BLOCKED_RECEIVER_EXTENSIONS = new Set(['.exe', '.dll', '.ps1', '.bat', '.cmd', '.js', '.vbs', '.msi', '.scr', '.com', '.pif', '.hta', '.wsh', '.wsf']);
function fail(code: ErrorCode, message: string): never { throw new DeqrProtocolError(code, message); }
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function xorChecksum(bytes: Uint8Array): number { return bytes.reduce((value, byte) => value ^ byte, 0); }
/** Compact duplicate marker. The container SHA-256 remains the integrity authority. */
function frameFingerprint(bytes: Uint8Array): number { let value = 0x811c9dc5; for (const byte of bytes) { value ^= byte; value = Math.imul(value, 0x01000193); } return value >>> 0; }
function safeText(bytes: Uint8Array, name: string): string { try { return decoder.decode(bytes); } catch { return fail('INVALID_METADATA', `${name} is not valid UTF-8`); } }
function isBlockedReceiverExtension(filename: string): boolean { return BLOCKED_RECEIVER_EXTENSIONS.has(filename.slice(filename.lastIndexOf('.')).toLowerCase()); }

export function parseFrame(raw: Uint8Array): ParseResult<DeqrFrame> {
  try {
    if (raw.length < HEADER_SIZE || raw.length > LIMITS.maxFrameBytes) fail('INVALID_FRAME', 'Frame length is outside the accepted bounds.');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (xorChecksum(raw.subarray(0, HEADER_SIZE - 1)) !== raw[HEADER_SIZE - 1]) fail('INVALID_FRAME', 'Frame header checksum does not match.');
    const header: FrameHeader = { protocolVersion: view.getUint8(0), sessionId: view.getUint32(1), segmentNumber: view.getUint16(5), sequenceNumber: view.getUint32(7), blockCount: view.getUint16(11), blockSize: view.getUint16(13), totalPayloadLength: view.getUint32(15) };
    if (header.protocolVersion !== PROTOCOL_VERSION) fail('UNSUPPORTED_PROTOCOL', `Protocol ${header.protocolVersion} is not supported.`);
    if (header.segmentNumber !== 0) fail('INVALID_FRAME', 'Multi-segment frames are not supported by protocol v1.');
    if (header.blockCount < 1 || header.blockCount > LIMITS.maxBlockCount || header.blockSize < 1 || header.blockSize > LIMITS.maxBlockSize) fail('RESOURCE_LIMIT_EXCEEDED', 'Frame block declaration exceeds receiver limits.');
    const reassemblyBytes = header.blockCount * header.blockSize;
    if (header.totalPayloadLength < 1 || header.totalPayloadLength > LIMITS.maxFileBytes || reassemblyBytes < header.totalPayloadLength || reassemblyBytes > header.totalPayloadLength + header.blockSize - 1) fail('RESOURCE_LIMIT_EXCEEDED', 'Frame length declaration is invalid.');
    if (raw.length !== HEADER_SIZE + header.blockSize) fail('INVALID_FRAME', 'Frame payload length does not match its block size.');
    // No raw/payload copy here; retaining a frame is the decoder's decision.
    return { ok: true, value: { header, payload: raw.subarray(HEADER_SIZE), raw, fingerprint: frameFingerprint(raw) } };
  } catch (error) {
    return { ok: false, error: error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_FRAME', 'Frame could not be parsed.') };
  }
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
  if (bytes.length < 60 || bytes.length > LIMITS.maxFileBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'Container is outside the accepted bounds.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  const take = (length: number): Uint8Array => { if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) fail('INVALID_METADATA', 'Container is truncated.'); const output = bytes.slice(offset, offset + length); offset += length; return output; };
  if (safeText(take(4), 'magic') !== 'DEQR') fail('INVALID_MAGIC', 'Container magic is not DEQR.');
  const version = view.getUint16(offset); offset += 2; if (version !== PROTOCOL_VERSION) fail('UNSUPPORTED_PROTOCOL', `Container protocol ${version} is not supported.`);
  const filenameLength = view.getUint16(offset); offset += 2; if (filenameLength > LIMITS.maxFilenameBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'Filename is too long.');
  const filename = sanitizeFilename(safeText(take(filenameLength), 'filename'));
  const mimeLength = view.getUint16(offset); offset += 2; if (mimeLength > LIMITS.maxMimeBytes) fail('RESOURCE_LIMIT_EXCEEDED', 'MIME type is too long.');
  const mimeType = safeText(take(mimeLength), 'MIME type');
  const sizeBig = view.getBigUint64(offset); offset += 8; if (sizeBig > BigInt(LIMITS.maxFileBytes)) fail('RESOURCE_LIMIT_EXCEEDED', 'Declared file is too large.');
  const originalSize = Number(sizeBig); const compressedFlag = view.getUint8(offset++); const encryptedFlag = view.getUint8(offset++);
  if (compressedFlag > 1 || encryptedFlag > 1) fail('INVALID_METADATA', 'Container flags are invalid.');
  take(8); const sha256 = take(32); const payload = take(bytes.length - offset);
  if (!compressedFlag && payload.length !== originalSize) fail('SIZE_MISMATCH', 'Uncompressed payload length does not match declared size.');
  return { filename, mimeType, originalSize, compressed: compressedFlag === 1, encrypted: encryptedFlag === 1, sha256, payload };
}

class Prng { private state: number; constructor(seed: number) { this.state = (seed || 0xdeadbeef) >>> 0; } next(): number { let value = (this.state += 0x6d2b79f5); value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000; } int(max: number): number { return Math.floor(this.next() * max); } }
class Soliton {
  private readonly cdf: number[];
  constructor(private readonly blockCount: number) { const s = 0.1 * Math.log(blockCount / 0.05) * Math.sqrt(blockCount); const rho = Array(blockCount + 1).fill(0); const tau = Array(blockCount + 1).fill(0); rho[1] = 1 / blockCount; for (let degree = 2; degree <= blockCount; degree++) rho[degree] = 1 / (degree * (degree - 1)); const limit = Math.floor(blockCount / s); for (let degree = 1; degree < limit; degree++) tau[degree] = s / (blockCount * degree); if (limit >= 1 && limit <= blockCount) tau[limit] = s * Math.log(s / 0.05) / blockCount; const sum = rho.reduce((total, value, index) => total + value + tau[index], 0); let running = 0; this.cdf = Array(blockCount + 1).fill(0); for (let degree = 1; degree <= blockCount; degree++) { running += (rho[degree] + tau[degree]) / sum; this.cdf[degree] = running; } }
  degree(prng: Prng): number { const probability = prng.next(); for (let degree = 1; degree <= this.blockCount; degree++) if (probability <= this.cdf[degree]) return degree; return this.blockCount; }
}
interface Node { sequence: number; neighbors: number[]; payload: Uint8Array; }

class FountainDecoder {
  private header: FrameHeader | null = null; private soliton: Soliton | null = null; private readonly unsolved = new Map<number, Node>(); private readonly seen = new Map<number, number>(); private blocks: Array<Uint8Array | undefined> = []; private solved = 0;
  receive(frame: DeqrFrame): 'accepted' | 'duplicate' | 'complete' {
    if (!this.header) { this.header = frame.header; this.soliton = new Soliton(frame.header.blockCount); this.blocks = Array(frame.header.blockCount); }
    else if (this.header.sessionId !== frame.header.sessionId) fail('SESSION_MISMATCH', 'Frame belongs to a different transfer.');
    else if (['blockCount', 'blockSize', 'totalPayloadLength'].some((key) => this.header![key as keyof FrameHeader] !== frame.header[key as keyof FrameHeader])) fail('INVALID_FRAME', 'Frame metadata conflicts with the active transfer.');
    const prior = this.seen.get(frame.header.sequenceNumber); if (prior !== undefined) { if (prior !== frame.fingerprint) fail('CONFLICTING_DUPLICATE', 'A sequence number was observed with different data.'); return 'duplicate'; }
    if (this.seen.size >= this.maximumSeenFrames()) fail('RESOURCE_LIMIT_EXCEEDED', 'Too many frames were observed for one transfer.'); this.seen.set(frame.header.sequenceNumber, frame.fingerprint);
    const node: Node = { sequence: frame.header.sequenceNumber, neighbors: this.neighbors(frame.header.sequenceNumber), payload: frame.payload.slice() }; this.eliminate(node);
    if (node.neighbors.length) { if (this.unsolved.size >= this.maximumUnsolvedFrames()) { node.payload.fill(0); fail('RESOURCE_LIMIT_EXCEEDED', 'Too many repair frames are buffered for one transfer.'); } this.unsolved.set(node.sequence, node); if (node.neighbors.length === 1) this.ripple(node); } else node.payload.fill(0);
    return this.solved === this.blocks.length ? 'complete' : 'accepted';
  }
  progress(): { solved: number; total: number } { return { solved: this.solved, total: this.blocks.length }; }
  reconstruct(): Uint8Array { if (!this.header || this.solved !== this.blocks.length) fail('TRANSFER_INCOMPLETE', 'Not all source blocks have been recovered.'); const joined = new Uint8Array(this.blocks.length * this.header.blockSize); this.blocks.forEach((block, index) => joined.set(block!, index * this.header!.blockSize)); return joined.subarray(0, this.header.totalPayloadLength); }
  dispose(): void { for (const node of this.unsolved.values()) { node.payload.fill(0); node.neighbors.length = 0; } for (const block of this.blocks) block?.fill(0); this.unsolved.clear(); this.seen.clear(); this.blocks = []; this.header = null; this.soliton = null; this.solved = 0; }
  private maximumSeenFrames(): number { if (!this.header) return 0; return Math.min(LIMITS.maxSeenFrames, this.header.blockCount + Math.max(1_024, this.header.blockCount)); }
  private maximumUnsolvedFrames(): number { return this.header ? Math.max(1, Math.floor(LIMITS.maxUnsolvedBytes / this.header.blockSize)) : 0; }
  private neighbors(sequence: number): number[] { if (!this.header || !this.soliton) return []; if (sequence < this.header.blockCount) return [sequence]; const prng = new Prng(sequence); const wanted = this.soliton.degree(prng); const selected = new Set<number>(); while (selected.size < wanted) selected.add(prng.int(this.header.blockCount)); return [...selected]; }
  private eliminate(node: Node): void { node.neighbors = node.neighbors.filter((index) => { const block = this.blocks[index]; if (!block) return true; for (let position = 0; position < node.payload.length; position++) node.payload[position] ^= block[position]; return false; }); }
  private ripple(initial: Node): void { const queue = [initial]; while (queue.length) { const node = queue.shift()!; if (node.neighbors.length !== 1) continue; const index = node.neighbors[0]; if (this.blocks[index]) { this.unsolved.delete(node.sequence); node.payload.fill(0); continue; } this.blocks[index] = node.payload.slice(); this.solved++; this.unsolved.delete(node.sequence); node.payload.fill(0); for (const [sequence, other] of this.unsolved) { const position = other.neighbors.indexOf(index); if (position < 0) continue; const block = this.blocks[index]!; for (let byte = 0; byte < other.payload.length; byte++) other.payload[byte] ^= block[byte]; other.neighbors.splice(position, 1); if (other.neighbors.length === 1) queue.push(other); else if (!other.neighbors.length) { this.unsolved.delete(sequence); other.payload.fill(0); } } } }
}

export type ReceiverState = 'READY' | 'RECEIVING' | 'VERIFYING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
export interface ReceiverSnapshot { state: ReceiverState; filename?: string; receivedBlocks: number; totalBlocks: number; duplicates: number; foreignFrames: number; error?: DeqrProtocolError; verified?: VerifiedFile; }
export interface VerifiedFile { filename: string; mimeType: string; bytes: Uint8Array; sha256: Uint8Array; }

export class ReceiverSession {
  private decoder = new FountainDecoder(); private state: ReceiverState = 'READY'; private duplicates = 0; private foreignFrames = 0; private activeSession?: number; private error?: DeqrProtocolError; private verified?: VerifiedFile; private progressState = { solved: 0, total: 0 }; private generation = 0; private verification?: Promise<ReceiverSnapshot>;
  receive(raw: Uint8Array): ReceiverSnapshot {
    if (this.state === 'COMPLETE' || this.state === 'FAILED' || this.state === 'CANCELLED') return this.snapshot();
    const parsed = parseFrame(raw); if (!parsed.ok) return this.failed(parsed.error);
    if (this.activeSession !== undefined && parsed.value.header.sessionId !== this.activeSession) { this.foreignFrames++; return this.snapshot(); }
    // A completion race may deliver one final QR frame while verification is
    // starting. Preserve conflict detection, but do not start a second verify.
    if (this.state === 'VERIFYING') {
      try {
        const outcome = this.decoder.receive(parsed.value);
        if (outcome === 'duplicate') this.duplicates++;
        this.progressState = this.decoder.progress();
        return this.snapshot();
      } catch (error) {
        return this.failed(error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_FRAME', 'Receiver rejected frame.'));
      }
    }
    this.activeSession ??= parsed.value.header.sessionId;
    try { const outcome = this.decoder.receive(parsed.value); if (outcome === 'duplicate') this.duplicates++; this.progressState = this.decoder.progress(); this.state = outcome === 'complete' ? 'VERIFYING' : 'RECEIVING'; return this.snapshot(); }
    catch (error) { return this.failed(error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_FRAME', 'Receiver rejected frame.')); }
  }
  verify(): Promise<ReceiverSnapshot> { if (this.state !== 'VERIFYING') return Promise.resolve(this.snapshot()); if (this.verification) return this.verification; const generation = this.generation; this.verification = this.verifyOnce(generation).finally(() => { if (generation === this.generation) this.verification = undefined; }); return this.verification; }
  cancel(): ReceiverSnapshot { this.clear(); this.state = 'CANCELLED'; return this.snapshot(); }
  reset(): ReceiverSnapshot { this.clear(); this.state = 'READY'; return this.snapshot(); }
  private async verifyOnce(generation: number): Promise<ReceiverSnapshot> {
    let reconstructed: Uint8Array | undefined; let container: Container | undefined; let bytes: Uint8Array | undefined;
    try {
      reconstructed = this.decoder.reconstruct(); container = parseContainer(reconstructed); reconstructed.fill(0); reconstructed = undefined;
      if (container.encrypted) fail('ENCRYPTED_CONTAINER', 'Encrypted payloads are not supported by protocol v1 receiver.');
      if (isBlockedReceiverExtension(container.filename)) fail('FILE_TYPE_BLOCKED', 'File extension is blocked by security policy.');
      bytes = container.compressed ? await inflateGzip(container.payload, container.originalSize) : container.payload; if (container.compressed) container.payload.fill(0);
      if (bytes.length !== container.originalSize) fail('SIZE_MISMATCH', 'Reconstructed file size does not match declared size.');
      const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input as ArrayBuffer));
      if (generation !== this.generation) { bytes.fill(0); hash.fill(0); return this.snapshot(); }
      if (!equal(hash, container.sha256)) { hash.fill(0); fail('HASH_MISMATCH', 'SHA-256 verification failed.'); }
      this.verified = { filename: container.filename, mimeType: container.mimeType || 'application/octet-stream', bytes, sha256: hash }; this.releaseDecoder(); this.state = 'COMPLETE'; return this.snapshot();
    } catch (error) { if (bytes && bytes !== this.verified?.bytes) bytes.fill(0); if (generation !== this.generation) return this.snapshot(); return this.failed(error instanceof DeqrProtocolError ? error : new DeqrProtocolError('INVALID_METADATA', 'Container verification failed.')); }
    finally {
      reconstructed?.fill(0);
      container?.sha256.fill(0);
      if (container && container.payload !== this.verified?.bytes) container.payload.fill(0);
    }
  }
  private releaseDecoder(): void { this.decoder.dispose(); this.decoder = new FountainDecoder(); }
  private clear(): void { this.generation++; this.verification = undefined; this.releaseDecoder(); this.verified?.bytes.fill(0); this.verified?.sha256.fill(0); this.duplicates = 0; this.foreignFrames = 0; this.activeSession = undefined; this.error = undefined; this.verified = undefined; this.progressState = { solved: 0, total: 0 }; }
  private failed(error: DeqrProtocolError): ReceiverSnapshot { this.generation++; this.verification = undefined; this.releaseDecoder(); this.verified?.bytes.fill(0); this.verified?.sha256.fill(0); this.verified = undefined; this.error = error; this.state = 'FAILED'; return this.snapshot(); }
  // `foreignFrames` is reported, not acted on. A session that latches onto one
  // transfer and then silently discards a second one looks identical to a dead
  // scanner; adopting the new session instead would quietly drop the isolation
  // guarantee, so the receiver surfaces the count and leaves the choice to reset.
  snapshot(): ReceiverSnapshot { return { state: this.state, filename: this.verified?.filename, receivedBlocks: this.progressState.solved, totalBlocks: this.progressState.total, duplicates: this.duplicates, foreignFrames: this.foreignFrames, error: this.error, verified: this.verified }; }
}

async function inflateGzip(payload: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  if (!('DecompressionStream' in globalThis)) fail('UNSUPPORTED_COMPRESSION', 'This browser cannot safely decompress gzip DEQR payloads.');
  const stream = new Blob([payload.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip')); const reader = stream.getReader(); const chunks: Uint8Array[] = []; let outputSize = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value.byteLength > expectedSize - outputSize) { try { await reader.cancel(); } catch { /* The size-limit violation is authoritative. */ } fail('SIZE_MISMATCH', 'Decompressed payload exceeded its declared size.'); } chunks.push(value); outputSize += value.byteLength; } const bytes = new Uint8Array(outputSize); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; chunk.fill(0); } return bytes; }
  catch (error) { for (const chunk of chunks) chunk.fill(0); throw error; }
  finally { reader.releaseLock(); }
}
