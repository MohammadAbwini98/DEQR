/**
 * Phase 00 — Receiver Memory Probe
 *
 * Measures what the shipping browser-safe receiver actually holds for one
 * transfer, instead of inferring it from the source.
 *
 * It is a separate script, and it measures exactly one size per process, for
 * two reasons. Running several sizes in one process contaminates the baseline —
 * the collector does not hand back the previous probe's buffers predictably, and
 * the deltas stop meaning anything. And the numbers only settle when the
 * allocations under test are the only large live objects created after the
 * baseline snapshot.
 *
 *   node --expose-gc node_modules/vite-node/vite-node.mjs \
 *     scripts/bench/phase00-receiver-memory.ts -- --mib 16
 *
 * `--expose-gc` is required. Without it the script refuses to report, because
 * un-collected garbage would be indistinguishable from retained state.
 *
 * Payload safety: synthetic deterministic bytes only; nothing about the payload
 * is printed or written.
 */

import { performance } from 'node:perf_hooks';

import { computeSha256 } from '../../src/core/hash';
import { PROTOCOL_VERSION, serializeContainer } from '../../src/core/container';
import { FountainEncoder } from '../../src/core/fountain-encoder';
import { serializeFrame } from '../../src/core/protocol';
import { V1_FOUNTAIN_BLOCK_SIZE_BYTES } from '../../src/main/session-manager';
import { ReceiverSession } from '../../mobile-web/src/protocol';

const MIB = 1024 * 1024;

function parseMib(argumentsList: string[]): number {
  const index = argumentsList.indexOf('--mib');
  if (index < 0) return 16;
  const parsed = Number(argumentsList[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
    throw new Error('--mib must be an integer between 1 and 31 (v1 cannot carry more).');
  }
  return parsed;
}

/**
 * Live bytes, settled.
 *
 * `heapUsed + external` after repeated collection is reproducible to about a
 * percent; `arrayBuffers` and `rss` on their own are not, because both move
 * with collection timing rather than with what the program is holding.
 */
function settled(): NodeJS.MemoryUsage {
  for (let pass = 0; pass < 3; pass += 1) global.gc!();
  return process.memoryUsage();
}

function live(usage: NodeJS.MemoryUsage): number {
  return usage.heapUsed + usage.external;
}

function report(label: string, usage: NodeJS.MemoryUsage): void {
  console.log(
    `${label.padEnd(14)} live=${(live(usage) / MIB).toFixed(1)}MiB`
    + ` heapUsed=${(usage.heapUsed / MIB).toFixed(1)}`
    + ` external=${(usage.external / MIB).toFixed(1)}`
    + ` arrayBuffers=${(usage.arrayBuffers / MIB).toFixed(1)}`
    + ` rss=${(usage.rss / MIB).toFixed(1)}`,
  );
}

if (typeof global.gc !== 'function') {
  console.error('PHASE00_RECEIVER_MEMORY_FAILED run node with --expose-gc');
  process.exit(1);
}

const payloadBytes = parseMib(process.argv.slice(2)) * MIB;

// Sender side, allocated before the baseline so it is not part of any delta.
// The encoder stores subarray views of this container, so the container buffer
// is the whole of the sender's steady-state cost.
const source = Buffer.alloc(payloadBytes, 0x5a);
const container = serializeContainer({
  metadata: {
    protocolVersion: PROTOCOL_VERSION,
    filename: 'receiver-memory-probe.bin',
    mimeType: 'application/octet-stream',
    originalSize: source.length,
    compressed: false,
    encrypted: false,
    timestamp: 0,
    sha256: computeSha256(source),
  },
  payload: source,
});
const encoder = new FountainEncoder(container, V1_FOUNTAIN_BLOCK_SIZE_BYTES, 0x5eed_1234);
const blockCount = encoder.getBlockCount();

const baseline = settled();
report('baseline', baseline);

const receiver = new ReceiverSession();
let state = receiver.snapshot();
let framesDelivered = 0;
const receiveStart = performance.now();
while (state.state !== 'VERIFYING' && framesDelivered < blockCount * 2 + 128) {
  state = receiver.receive(new Uint8Array(serializeFrame(encoder.nextFrame())));
  framesDelivered += 1;
  if (state.state === 'FAILED') break;
}
const receiveMs = performance.now() - receiveStart;

const afterReceive = settled();
report('afterReceive', afterReceive);

const verifyStart = performance.now();
const verification = await receiver.verify();
const verifyMs = performance.now() - verifyStart;

const afterVerify = settled();
report('afterVerify', afterVerify);

const decoderHeld = live(afterReceive) - live(baseline);
const retained = live(afterVerify) - live(baseline);

console.log(
  `PHASE00_RECEIVER_MEMORY payload=${(payloadBytes / MIB).toFixed(0)}MiB blocks=${blockCount}`
  + ` frames=${framesDelivered} receiveMs=${receiveMs.toFixed(0)} verifyMs=${verifyMs.toFixed(0)}`
  + ` verify=${verification.state}`
  + ` decoderHeld=${(decoderHeld / MIB).toFixed(1)}MiB(${(decoderHeld / payloadBytes).toFixed(2)}x)`
  + ` perBlockOverhead=${((decoderHeld - blockCount * V1_FOUNTAIN_BLOCK_SIZE_BYTES) / blockCount).toFixed(0)}B`
  + ` retainedAfterVerify=${(retained / MIB).toFixed(1)}MiB(${(retained / payloadBytes).toFixed(2)}x)`
  + ` peakRss=${(Math.max(afterReceive.rss, afterVerify.rss) / MIB).toFixed(1)}MiB`,
);

receiver.reset();
container.fill(0);
source.fill(0);
