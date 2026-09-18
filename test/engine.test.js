/* XBOST engine unit tests (run: npm test). Pure quant logic, no DOM. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

function bars(n, fn) {
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2024-01-02T09:15:00');
  for (let i = 0; i < n; i++) { const b = fn(i); t[i] = t0 + i * 60000; o[i] = b[0]; h[i] = b[1]; l[i] = b[2]; c[i] = b[3]; v[i] = b[4] || 1000; }
  return { t, o, h, l, c, v };
}
const ones = n => new Int8Array(n).fill(1);

test('parseCSV handles header + sorts ascending', () => {
  const d = E.parseCSV('date,open,high,low,close,volume\n2024-01-03 09:16:00,10,11,9,10,5\n2024-01-03 09:15:00,9,10,9,10,7\n');
  assert.equal(d.t.length, 2);
  assert.ok(d.t[0] < d.t[1]);
  assert.equal(d.v[0], 7);
});

test('resample aggregates OHLCV exactly', () => {
  const d = bars(10, i => [100 + i, 100 + i + 1, 100 + i - 1, 100 + i + 0.5, 10]);
  const r = E.resample(d, 5);
  assert.equal(r.t.length, 2);
  assert.equal(r.o[0], 100);
  assert.equal(r.h[0], 105);
  assert.equal(r.l[0], 99);
  assert.equal(r.c[0], 104.5);
  assert.equal(r.v[0], 50);
});

test('flat market: no stop fills, pnl == -n*cost', () => {
  const d = bars(200, () => [100, 100, 100, 100, 1000]);
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: ones(200), slPct: 1, tpPct: 2, capital: 100000, qty: 10, lotSize: 1, cost: 20 });
  assert.ok(!bt.trades.some(t => ['SL', 'TP', 'TRAIL', 'BE', 'ATR'].includes(t.reason)));
  assert.ok(Math.abs(bt.metrics.netPnL + bt.trades.length * 20) < 0.01);
});

test('slope ride: pnl exact to the decimal, warmup clean', () => {
  const d = bars(60, i => { const c = 100 + i; return [c, c + 0.1, c - 0.1, c, 1000]; });
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Long', sessionMask: ones(60), slPct: 50, tpPct: 200, capital: 100000, qty: 10, lotSize: 1, cost: 20 });
  assert.equal(bt.trades.length, 1);
  const t = bt.trades[0];
  assert.ok(t.entryIdx >= 8);
  assert.ok(Math.abs(t.pnl - ((d.c[t.exitIdx] - d.c[t.entryIdx]) * 10 - 20)) < 0.01);
});

test('gap through stop fills at the stop price', () => {
  const d = bars(45, i => { if (i < 30) return [100, 100, 100, 100, 1000]; if (i === 30) return [100, 100, 50, 51, 5000]; return [51, 51.1, 50.9, 51, 1000]; });
  const forced = new Int8Array(45).fill(1);
  const bt = E.backtest(d, forced, { direction: 'Both', sessionMask: ones(45), slPct: 1, tpPct: 50, capital: 100000, qty: 10, lotSize: 1, cost: 20 });
  const sl = bt.trades.find(t => t.reason === 'SL');
  assert.ok(sl);
  assert.ok(Math.abs(sl.exitPx - 99) < 1e-9);
});

test('grid + rank + refine helpers behave', () => {
  const grid = E.buildGrid(
    [{ indicator: 'EMA', ranges: { period: { min: 9, max: 15, step: 6 } }, timeframes: [5] }],
    { sl: [0.5, 0.8], tp: [1.0] },
    { exits: ['fixed', 'breakeven'], carry: [false] });
  assert.equal(grid.length, 2 * 2 * 1 * 2);
  const keys = new Set(grid.map(c => E.cfgKey(c)));
  assert.equal(keys.size, grid.length);
  const nb = E.paramNeighbors(grid[0], { period: 6 }, { sl: 0.3, tp: 0.5 });
  assert.ok(nb.length > 0 && nb.every(c => c.exit === grid[0].exit));
  const ranked = E.rankResults(grid.map((g, i) => ({
    timeframe: g.timeframe, indicator: g.indicator, params: g.params,
    m: { netPnL: i, winRate: i, totalTrades: i + 1, profitFactor: 1, maxDD: -1, sharpe: i, sortino: i, expectancy: 1 }
  })), 'sharpe');
  assert.ok(ranked[0].m.sharpe >= ranked[1].m.sharpe);
});
