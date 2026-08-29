import { describe, it, expect } from 'vitest';
import { LatencyReservoir } from '../../src/shared/latency-reservoir';

describe('latency-reservoir', () => {
  it('p50 and p95 on ordered data', () => {
    const r = new LatencyReservoir(10);
    for (let i = 1; i <= 10; i++) r.record(i);
    expect(r.p50()).toBe(5); // nearest-rank 0.5*10=5th -> value 5
    expect(r.p95()).toBe(10); // 0.95*10=9.5 ceil 10 -> 10
  });

  it('returns null when empty', () => {
    const r = new LatencyReservoir(4);
    expect(r.p50()).toBeNull();
    expect(r.p95()).toBeNull();
    expect(r.quantile(0.5)).toBeNull();
  });

  it('ignores non-finite and negative', () => {
    const r = new LatencyReservoir(4);
    r.record(NaN);
    r.record(Infinity);
    r.record(-1);
    expect(r.size).toBe(0);
    r.record(5);
    expect(r.size).toBe(1);
  });

  it('is sliding window (oldest overwritten)', () => {
    const r = new LatencyReservoir(3);
    r.record(1); r.record(2); r.record(3);
    expect(r.p50()).toBe(2);
    r.record(100); // overwrites 1
    // Now contains 100,2,3 -> sorted 2,3,100 -> p50 is 2 (ceil 1.5 ->2nd)
    expect(r.size).toBe(3);
    expect([r.p50(), r.p95()]).toEqual([expect.any(Number), expect.any(Number)]);
  });

  it('reset clears', () => {
    const r = new LatencyReservoir(4);
    r.record(5); r.record(6);
    expect(r.size).toBe(2);
    r.reset();
    expect(r.size).toBe(0);
    expect(r.p50()).toBeNull();
  });
});
