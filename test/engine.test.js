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

test('trigger entries fire only on fresh edges, no flip chains', () => {
  const d = bars(120, i => { const c = 100 + 8 * Math.sin(i / 6) + i * 0.05; return [c, c + 0.2, c - 0.2, c, 1000]; });
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const base = { direction: 'Both', slPct: 5, tpPct: 20, capital: 100000, qty: 10, lotSize: 1, cost: 0 };
  const mask = E.buildSessionMask(d, null, null);
  const ba = E.backtest(d, sig.pos, Object.assign({ sessionMask: mask }, base));
  const bt = E.backtest(d, sig.pos, Object.assign({ sessionMask: mask, entry: 'trigger' }, base));
  assert.ok(bt.trades.length > 0 && bt.trades.length <= ba.trades.length);
  for (const t of bt.trades) {
    assert.ok(sig.pos[t.entryIdx] !== sig.pos[t.entryIdx - 1], 'entry must be a fresh edge');
  }
  for (let k = 1; k < bt.trades.length; k++) {
    const chained = bt.trades[k].entryIdx === bt.trades[k - 1].exitIdx;
    if (chained) assert.ok(sig.pos[bt.trades[k].entryIdx] !== sig.pos[bt.trades[k].entryIdx - 1], 'no same-signal re-entry');
  }
});

test('MTM equity + DD attribution are consistent', () => {
  const d = bars(120, i => { const c = 100 + 8 * Math.sin(i / 6) - i * 0.02; return [c, c + 0.2, c - 0.2, c, 1000]; });
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: E.buildSessionMask(d, null, null), slPct: 5, tpPct: 20, capital: 100000, qty: 10, lotSize: 1, cost: 0 });
  const m = bt.metrics;
  assert.equal(bt.equity.length, d.t.length);
  assert.ok(isFinite(m.ddPeakTime) && isFinite(m.ddTroughTime) && m.ddPeakTime <= m.ddTroughTime);
  assert.ok(m.maxDD <= 0);
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

test('next-open fills print at open[i+1]', () => {
  const d = bars(60, i => { const c = 100 + i; return [c, c + 0.1, c - 0.1, c, 1000]; });
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Long', sessionMask: new Int8Array(60).fill(1), slPct: 50, tpPct: 200, capital: 100000, qty: 10, lotSize: 1, cost: 0, fill: 'next' });
  assert.ok(bt.trades.length > 0);
  for (const t of bt.trades) {
    assert.ok(t.entryIdx > 0);
    assert.ok(Math.abs(t.entryPx - d.o[t.entryIdx]) < 1e-9);
  }
});

test('same-bar SL+TP collision resolves to SL', () => {
  const d = bars(30, i => i < 10 ? [100, 100.1, 99.9, 100, 1000] : [100, 102, 98, 101, 1000]);
  const forced = new Int8Array(30).fill(1);
  const bt = E.backtest(d, forced, { direction: 'Long', sessionMask: new Int8Array(30).fill(1), slPct: 1, tpPct: 1, capital: 100000, qty: 10, lotSize: 1, cost: 0 });
  const stops = bt.trades.filter(t => t.reason === 'SL');
  assert.ok(stops.length > 0, 'expected SL-wins-tie exits');
  assert.ok(!bt.trades.some(t => t.reason === 'TP' && t.exitIdx === stops[0].exitIdx));
});

test('cash identity holds with costs itemised', () => {
  const d = bars(80, i => { const c = 100 + 5 * Math.sin(i / 5); return [c, c + 0.3, c - 0.3, c, 1000]; });
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: new Int8Array(80).fill(1), slPct: 2, tpPct: 3, capital: 50000, qty: 5, lotSize: 1, cost: 7 });
  const m = bt.metrics;
  assert.equal(m.totalCosts, bt.trades.length * 7);
  assert.ok(Math.abs(m.finalCapital - (50000 + m.netPnL)) < 1e-6);
  assert.ok(Math.abs((m.grossPreCost - m.totalCosts) - m.netPnL) < 1e-6);
});

test('ruin halts: flat tail, no post-ruin entries', () => {
  const d = bars(120, i => { const c = 100 + i; return [c, c + 0.1, c - 0.1, c, 1000]; });
  const forced = new Int8Array(120).fill(-1);
  const bt = E.backtest(d, forced, { direction: 'Both', sessionMask: new Int8Array(120).fill(1), slPct: 0.5, tpPct: 50, capital: 2000, qty: 100, lotSize: 1, cost: 20 });
  let runEq = 2000, ruinAt = -1;
  for (const t of bt.trades) { runEq += t.pnl; if (runEq <= 0 && ruinAt < 0) ruinAt = t.exitIdx; }
  if (ruinAt >= 0) {
    assert.ok(!bt.trades.some(t => t.entryIdx > ruinAt));
    for (let i = ruinAt; i < 120; i++) assert.equal(bt.equity[i], runEq);
  }
});

test('new indicators + presets run with warmup quarantine', () => {
  const d = bars(150, i => { const c = 100 + 6 * Math.sin(i / 7) + i * 0.03; return [c, c + 0.4, c - 0.4, c, 2000]; });
  const legs = [
    ['Chop', { chopPeriod: 14, gate: 61.8, maPeriod: 30 }],
    ['Cyber', { alpha: 0.07 }], ['VWMA', { period: 20 }],
    ['CMO', { period: 9, oversold: -50, overbought: 50 }],
    ['Aroon', { period: 25, level: 0 }],
    ['SqueezeBreak', { period: 20, bbMult: 2, kcMult: 1.5, volMult: 2, ckMult: 3 }],
    ['TrendRegime', { chopPeriod: 14, gate: 55, stMult: 3, macdFast: 12 }],
    ['VWAPRev', { sd1: 1.5, sd2: 2, cmoPeriod: 5, cmoOS: -50, cmoOB: 50 }],
  ];
  for (const [ind, params] of legs) {
    const sig = E.buildSignals(d, { indicator: ind, params });
    assert.ok(sig.pos.length === 150);
    const o = { direction: 'Both', sessionMask: new Int8Array(150).fill(1), slPct: 2, tpPct: 4, capital: 100000, qty: 10, lotSize: 1, cost: 0 };
    if (ind === 'SqueezeBreak') { o.exit = 'ck'; const xo = E.exitOptsFromParams(ind, params); o.ckPeriod = xo.ckPeriod; o.ckMult = xo.ckMult; }
    const bt = E.backtest(d, sig.pos, o);
    assert.ok(bt.trades.every(t => t.entryIdx >= 0 && t.exitIdx > t.entryIdx));
    assert.ok(isFinite(bt.metrics.sharpe) && isFinite(bt.metrics.maxDD));
  }
});
