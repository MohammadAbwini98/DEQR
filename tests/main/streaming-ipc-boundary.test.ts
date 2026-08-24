import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The privileged/renderer boundary for the v2 streaming sender.
 *
 * Two separate claims are under test here, and they fail in different ways.
 *
 * The **capability** claim is that the renderer is never handed a filesystem
 * primitive or a path — only a session id, sanitized metadata, and one
 * QR-ready frame at a time. That one is checked against the real registration
 * and the real preload bridge, never against a maintained list, because
 * DESKTOP-SEC-050 was caused by exactly such a list drifting from the code it
 * claimed to describe.
 *
 * The **volume** claim is that no single response can carry the file. A
 * transfer does of course put every byte in front of the renderer eventually —
 * it has to draw them — but it does so one bounded symbol at a time.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  exposed: new Map<string, unknown>(),
  invoked: new Set<string>(),
  selectedPath: { value: '' },
}));

vi.mock('electron', () => ({
  get app() {
    return { isPackaged: false, getPath: () => 'C:\\deqr-test-userdata' };
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  ipcRenderer: {
    invoke: vi.fn((channel: string) => {
      mocks.invoked.add(channel);
      return Promise.resolve();
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, api: unknown) => mocks.exposed.set(key, api)),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({})),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [mocks.selectedPath.value] })),
    showSaveDialog: vi.fn(),
  },
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';
import { StreamingSessionRegistry } from '../../src/main/streaming-session-registry';
import { V2_DATA_LAYOUT, V2_FRAME_TYPE, parseFrame, symbolByteRange } from '../../src/core/protocol-v2';
import '../../src/preload/index';

/**
 * Every privileged streaming channel, listed so adding one is a deliberate act.
 *
 * `beginRecovery` was added in Phase 13 and this list is why it could not be
 * added quietly: a new main-process capability reachable from the renderer has
 * to be reviewed, not discovered later. It takes a session id and an optional
 * list of segment indices, and can start frame generation - which is exactly
 * the kind of thing that should cost a test edit.
 */
const STREAM_CHANNELS = [
  'streamTransfer:select',
  'streamTransfer:nextFrame',
  'streamTransfer:progress',
  'streamTransfer:beginRecovery',
  'streamTransfer:cancel',
] as const;

let temporaryDirectory = '';
let fixturePath = '';
let fixtureBytes: Uint8Array;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'deqr-stream-'));
  fixturePath = path.join(temporaryDirectory, 'boundary-fixture.bin');
  // Not synthetic: this is the one test that drives the real file opener, so a
  // real file on a real filesystem is the point of it.
  fixtureBytes = new Uint8Array(randomBytes(200 * 1024));
  await writeFile(fixturePath, fixtureBytes);
  mocks.selectedPath.value = fixturePath;
});

afterAll(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('the v2 streaming channels exist and are registered like every other channel', () => {
  it('registers exactly the streaming channels it declares, all through the trusted wrapper', () => {
    registerIpcHandlers();
    for (const channel of STREAM_CHANNELS) {
      expect(mocks.handlers.has(channel), channel).toBe(true);
    }
    // `ipc-sender-policy.test.ts` enumerates whatever is registered and proves
    // each channel rejects an untrusted frame, so these are covered there by
    // construction rather than by being added to a list.
    const streaming = [...mocks.handlers.keys()].filter((channel) => channel.startsWith('streamTransfer:'));
    expect(streaming.sort()).toEqual([...STREAM_CHANNELS].sort());
  });

  it('exposes exactly those and nothing else on the preload bridge', () => {
    const api = mocks.exposed.get('deqr') as { streamTransfer: Record<string, unknown> };
    expect(Object.keys(api.streamTransfer).sort())
      .toEqual(['beginRecovery', 'cancel', 'nextFrame', 'progress', 'select']);
  });

  it('exposes no channel that reads an arbitrary path', () => {
    // A capability like `files:read(path)` would defeat the whole boundary, so
    // this asserts against the real registration rather than intent.
    for (const channel of mocks.handlers.keys()) {
      expect(channel).not.toMatch(/read(file|path)|openpath|readdir|writefile/i);
    }
  });
});

describe('a real file streams through the real opener', () => {
  it('hands the renderer metadata with no path in it', async () => {
    const registry = new StreamingSessionRegistry(undefined, {
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 512,
      sampleCompressibility: false,
      hashChunkBytes: 32 * 1024,
    });

    const selection = await registry.selectFile({} as never);
    expect(selection).not.toBeNull();
    const metadata = selection!.metadata;

    expect(metadata.filename).toBe('boundary-fixture.bin');
    expect(metadata.originalSizeBytes).toBe(String(fixtureBytes.length));
    expect(metadata.sha256).toBe(createHash('sha256').update(fixtureBytes).digest('hex'));

    // Both sizes cross, not one. For a compressed transfer they are two
    // different facts - what the file weighs and what has to cross the optical
    // link - and a UI that only received the first could not report either
    // honestly. Sampling is off here, so this transfer is uncompressed and the
    // two agree, which is the rule rather than a coincidence.
    expect(metadata.transportSizeBytes).toBe(metadata.originalSizeBytes);
    expect(metadata.compressionMode).toBe(0);
    expect(metadata.compressionRatio).toBe(1);
    expect(typeof metadata.compressionReason).toBe('string');

    // Nothing in what crosses the boundary may disclose where the file lives.
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(temporaryDirectory);
    expect(serialized).not.toContain(path.sep === '\\' ? temporaryDirectory.replace(/\\/g, '\\\\') : temporaryDirectory);
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/tmp\//);

    await registry.cancel(selection!.sessionId);
  });

  it('delivers the file one bounded frame at a time, and it reconstructs', async () => {
    const registry = new StreamingSessionRegistry(undefined, {
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 512,
      repairOverheadRatio: 0,
      manifestIntervalFrames: 64,
      sampleCompressibility: false,
      hashChunkBytes: 32 * 1024,
    });
    const selection = await registry.selectFile({} as never);
    const sessionId = selection!.sessionId;

    const rebuilt = new Uint8Array(fixtureBytes.length);
    const covered = new Uint8Array(fixtureBytes.length);
    let largestResponse = 0;
    let frames = 0;
    let plan: ReturnType<typeof symbolByteRange> | null = null;
    let segmentPlan: Parameters<typeof symbolByteRange>[0] | null = null;

    while (true) {
      const result = await registry.nextFrame(sessionId);
      if (!result.frame) break;
      frames += 1;
      largestResponse = Math.max(largestResponse, result.frame.length);

      const parsed = parseFrame(result.frame);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) break;
      if (parsed.value.kind === 'manifest') {
        const { planSegmentation } = await import('../../src/core/protocol-v2');
        segmentPlan = planSegmentation({
          transportSize: parsed.value.manifest.transportSize,
          segmentSizeBytes: parsed.value.manifest.segmentSizeBytes,
          symbolSizeBytes: parsed.value.manifest.symbolSizeBytes,
        });
        continue;
      }
      const data = parsed.value.frame;
      if (data.frameType !== V2_FRAME_TYPE.SOURCE || !segmentPlan) continue;
      plan = symbolByteRange(segmentPlan, data.segmentIndex, data.symbolId);
      const start = Number(plan.start);
      const length = Number(plan.end - plan.start);
      rebuilt.set(data.payload.subarray(0, length), start);
      covered.fill(1, start, start + length);
    }

    // No response can carry the file: the largest is one symbol plus its header.
    expect(largestResponse).toBeLessThanOrEqual(512 + V2_DATA_LAYOUT.overheadBytes);
    expect(largestResponse * frames).toBeGreaterThan(fixtureBytes.length);
    expect(covered.every((byte) => byte === 1)).toBe(true);
    expect(Array.from(rebuilt)).toEqual(Array.from(fixtureBytes));

    const progress = await registry.progress(sessionId);
    expect(progress.complete).toBe(true);
    expect(progress.transportBytesCovered).toBe(String(fixtureBytes.length));

    await registry.cancel(sessionId);
    expect(registry.activeSessionCount).toBe(0);
  });

  it('releases every session and its descriptor on shutdown', async () => {
    const registry = new StreamingSessionRegistry(undefined, {
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 512,
      sampleCompressibility: false,
      hashChunkBytes: 32 * 1024,
    });
    const first = await registry.selectFile({} as never);
    const second = await registry.selectFile({} as never);
    expect(registry.activeSessionCount).toBe(2);

    await registry.disposeAll();
    expect(registry.activeSessionCount).toBe(0);

    // A released session answers nothing further.
    await expect(registry.nextFrame(first!.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(registry.nextFrame(second!.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('treats cancelling an unknown or already-cancelled session as a no-op', async () => {
    const registry = new StreamingSessionRegistry(undefined, {
      segmentSizeBytes: 64 * 1024,
      symbolSizeBytes: 512,
      sampleCompressibility: false,
      hashChunkBytes: 32 * 1024,
    });
    await expect(registry.cancel(999)).resolves.toBeUndefined();

    const selection = await registry.selectFile({} as never);
    await registry.cancel(selection!.sessionId);
    await expect(registry.cancel(selection!.sessionId)).resolves.toBeUndefined();
  });

  it('returns null rather than a session when the dialog is cancelled', async () => {
    const { dialog } = await import('electron');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as never);
    const registry = new StreamingSessionRegistry();
    await expect(registry.selectFile({} as never)).resolves.toBeNull();
    expect(registry.activeSessionCount).toBe(0);
  });
});
