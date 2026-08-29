import { describe, it, expect } from 'vitest';
import { DiagnosticsTimelineSampler } from '../../src/shared/diagnostics-timeline';

describe('diagnostics-timeline', () => {
  it('samples every ~500ms and is monotonic', () => {
    const sampler = new DiagnosticsTimelineSampler(500);
    sampler.start(0);
    sampler.sample(0, { captureFps: 0, decodeFps: 0, uniqueSymbols: 0, solvedBlocks: 0, usefulBytesRecovered: 0, workerUtilization: 0, queueDepth: 0, cumulativeFullScans: 0 });
    // Too close — should be skipped (<400ms)
    sampler.sample(100, { captureFps: 22, decodeFps: 18, uniqueSymbols: 1, solvedBlocks: 1, usefulBytesRecovered: 686, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 2 });
    expect(sampler.snapshot().length).toBe(1);
    // Far enough — accepted
    sampler.sample(600, { captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 });
    expect(sampler.snapshot().length).toBe(2);
    const snap = sampler.snapshot();
    expect(snap[0].elapsedSeconds).toBe(0);
    expect(snap[1].elapsedSeconds).toBeCloseTo(0.6, 5);
    expect(snap[1].captureFps).toBe(22);
  });

  it('captures required 8 fields + elapsed', () => {
    const sampler = new DiagnosticsTimelineSampler(500);
    sampler.start(1000);
    sampler.sample(1000, { captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 });
    const s = sampler.snapshot()[0];
    expect(s).toHaveProperty('elapsedSeconds');
    expect(s).toHaveProperty('captureFps');
    expect(s).toHaveProperty('decodeFps');
    expect(s).toHaveProperty('uniqueSymbols');
    expect(s).toHaveProperty('solvedBlocks');
    expect(s).toHaveProperty('usefulBytesRecovered');
    expect(s).toHaveProperty('workerUtilization');
    expect(s).toHaveProperty('queueDepth');
    expect(s).toHaveProperty('cumulativeFullScans');
  });

  it('reset clears timeline', () => {
    const sampler = new DiagnosticsTimelineSampler(500);
    sampler.start(0);
    sampler.sample(0, { captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 });
    expect(sampler.snapshot().length).toBe(1);
    sampler.reset();
    expect(sampler.snapshot().length).toBe(0);
  });

  it('snapshot is deterministic and pure (copy)', () => {
    const sampler = new DiagnosticsTimelineSampler(500);
    sampler.start(0);
    sampler.sample(0, { captureFps: 22, decodeFps: 18, uniqueSymbols: 6, solvedBlocks: 6, usefulBytesRecovered: 4116, workerUtilization: 0.5, queueDepth: 1, cumulativeFullScans: 11 });
    const a = sampler.snapshot();
    const b = sampler.snapshot();
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // copy
  });
});
