import { describe, expect, it } from 'vitest';
import { monteCarloDD } from './stress';

const mkTrades = (n: number) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ pnl: i % 3 === 0 ? -50 : 30 } as any);
  return out;
};

describe('monteCarloDD safety caps', () => {
  it('small input: exact iters, uncapped', () => {
    const r = monteCarloDD(mkTrades(200), 100000, 1000, 42)!;
    expect(r.iters).toBe(1000);
    expect(r.capped).toBe(false);
    expect(r.p5).toBeLessThanOrEqual(r.p50);
  });
  it('giant input: capped at 20k trades, iters scaled to ≤20M ops', () => {
    const r = monteCarloDD(mkTrades(60000), 100000, 5000, 42)!;
    expect(r.capped).toBe(true);
    expect(r.nTrades).toBe(20000);
    expect(r.iters * 20000).toBeLessThanOrEqual(20000000);
    expect(r.iters).toBeGreaterThanOrEqual(100);
  });
  it('deterministic given seed', () => {
    const a = monteCarloDD(mkTrades(500), 100000, 200, 7)!;
    const b = monteCarloDD(mkTrades(500), 100000, 200, 7)!;
    expect(a.p50).toBe(b.p50);
  });
  it('empty input returns null', () => {
    expect(monteCarloDD([], 100000)).toBeNull();
  });
});
