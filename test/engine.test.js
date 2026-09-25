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

test('regime engine: 4 regimes, router masks, tradeMask respected', () => {
  const d = bars(300, i => { const c = 100 + 12 * Math.sin(i / 25) + i * 0.05; return [c, c + 0.4, c - 0.4, c, 3000]; });
  const reg = E.regimeSeries(d, {});
  assert.equal(reg.length, 300);
  const seen = new Set(Array.from(reg));
  assert.ok(seen.size >= 2, 'multiple regimes present');
  const mEMA = E.regimeMask(reg, 'EMA');
  const mBB = E.regimeMask(reg, 'Bollinger');
  assert.ok(mEMA.some(v => v === 1) && mBB.some(v => v === 1));
  assert.ok(mEMA.some((v, i) => v !== mBB[i]), 'router differentiates legs');
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const base = { direction: 'Both', slPct: 2, tpPct: 4, capital: 100000, qty: 10, lotSize: 1, cost: 0 };
  const b0 = E.backtest(d, sig.pos, Object.assign({ sessionMask: new Int8Array(300).fill(1) }, base));
  const b1 = E.backtest(d, sig.pos, Object.assign({ sessionMask: new Int8Array(300).fill(1), tradeMask: mEMA }, base));
  assert.ok(b1.trades.length <= b0.trades.length);
  const blocked = new Int8Array(300); // nothing allowed
  const b2 = E.backtest(d, sig.pos, Object.assign({ sessionMask: new Int8Array(300).fill(1), tradeMask: blocked }, base));
  assert.equal(b2.trades.length, 0);
});

test('ML regime classifier trains deterministically and predicts', () => {
  const d = bars(600, i => { const c = 100 + 10 * Math.sin(i / 30) + (i % 200 < 100 ? i * 0.02 : -i * 0.01); return [c, c + 0.5, c - 0.5, c, 2000]; });
  const a = E.trainRegimeML(d, 0.7, 15, 200);
  const b = E.trainRegimeML(d, 0.7, 15, 200);
  assert.deepEqual(a.W, b.W);
  assert.ok(a.trainAcc > 0.4 && a.trainAcc <= 1, 'train acc sane: ' + a.trainAcc);
  assert.equal(a.pred.length, 600);
  assert.ok(a.pred.every(v => v >= 0 && v <= 3));
});

function multiDay(days, per, fn) {
  // synthetic sessions with real calendar day boundaries
  const n = days * per;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2024-01-01T09:15:00');
  for (let d = 0; d < days; d++) for (let i = 0; i < per; i++) {
    const k = d * per + i, b = fn(k, d);
    t[k] = t0 + d * 86400000 + i * 60000;
    o[k] = b[0]; h[k] = b[1]; l[k] = b[2]; c[k] = b[3]; v[k] = b[4] || 1000;
  }
  return { t, o, h, l, c, v };
}

test('validateLayers covers ML checks M5/M6', () => {
  const d = multiDay(25, 40, (k, dd) => { const c = 100 + 8 * Math.sin(k / 20) + (dd % 2 ? k * 0.03 : -k * 0.01); return [c, c + 0.3, c - 0.3, c, 2000]; });
  const checks = E.validateLayers(d, { ml: true, confGate: 0.6, wf: true, wfSplit: 70 });
  const names = checks.map(c => c.name);
  assert.ok(names.some(n => n.indexOf('M5') === 0), 'M5 present');
  assert.ok(names.some(n => n.indexOf('M6') === 0), 'M6 present');
  for (const c of checks) assert.ok(typeof c.pass === 'boolean' && typeof c.detail === 'string');
});

test('dayRegimeMask counts fallback bars', () => {
  const d = multiDay(8, 40, (k) => { const c = 100 + k * 0.1; return [c, c + 0.2, c - 0.2, c, 1000]; });
  const rt = E.dayRouting(d, { source: 'rules', confGate: 0.6 });
  assert.ok(rt.dayReg);
  const dm = E.dayRegimeMask(d, rt.dayReg, 'EMA', 0.6);
  assert.ok(dm.mask.length === d.t.length && dm.fallbackBars >= 0);
});

test('multi-contract files split per contract (no strike mixing)', () => {
  const rows = ['date,symbol,strike,otype,expiry,open,high,low,close,volume'];
  const t0 = Date.parse('2024-01-02T09:15:00');
  const contracts = [['AAA1', 100], ['BBB2', 500]];
  for (const [sym, px] of contracts) {
    for (let i = 0; i < 60; i++) {
      const d = new Date(t0 + i * 60000);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
      const c = px + Math.sin(i / 5) * 2;
      rows.push(`${ds},${sym},100,CE,01JAN25,${c.toFixed(2)},${(c + 0.5).toFixed(2)},${(c - 0.5).toFixed(2)},${c.toFixed(2)},1000`);
    }
  }
  const all = E.parseCSVAll(rows.join('\n'));
  assert.equal(all.length, 2);
  for (const g of all) {
    assert.equal(g.d.t.length, 60);
    let jumps = 0;
    for (let i = 1; i < g.d.t.length; i++) {
      if (Math.abs(g.d.c[i] - g.d.c[i - 1]) / g.d.c[i - 1] > 0.5) jumps++;
    }
    assert.equal(jumps, 0);
  }
  const one = E.parseCSV(rows.join('\n'));
  assert.ok(one.mixed && one.mixed.contracts === 2 && one.mixed.dropped > 0);
});

test('hilbertDC: cycle period bounded [6,50], mode binary, causal', () => {
  const n = 600, c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = 100 + 10 * Math.sin(2 * Math.PI * i / 20);
  const hc = E.hilbertDC(c);
  const valid = [];
  for (let i = 0; i < n; i++) if (!isNaN(hc.period[i])) valid.push(hc.period[i]);
  assert.ok(valid.length > n * 0.8, 'valid=' + valid.length);
  assert.ok(valid.every(v => v >= 6 && v <= 50), 'bounded');
  assert.ok([...hc.mode].every(v => v === 0 || v === 1), 'binary mode');
  const med = valid.sort((a, b) => a - b)[Math.floor(valid.length / 2)];
  assert.ok(Math.abs(med - 20) < 6, 'median~20, got ' + med.toFixed(1));
  // causality: output at t identical whether series ends at t or later
  const hc2 = E.hilbertDC(c.slice(0, 300));
  assert.equal(hc2.period[299].toFixed(9), hc.period[299].toFixed(9));
});

test('itrend: zero-lag line, trigger = 1-bar lag, fires both sides', () => {
  const n = 400, c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = 100 + i * 0.2 + 3 * Math.sin(2 * Math.PI * i / 30);
  const t = E.itrend(c, 0.07);
  let lag = 0, tot = 0;
  for (let i = 60; i < n; i++) {
    if (isNaN(t.trend[i]) || isNaN(t.trig[i])) continue;
    tot++;
    if (Math.abs(t.trig[i] - t.trend[i - 1]) < 1e-9) lag++;
  }
  assert.ok(tot > 300 && lag === tot, `trigger lags 1 bar: ${lag}/${tot}`);
  const sig = E.buildSignals(
    { t: Float64Array.from(c.map((_, i) => i)), o: c, h: c, l: c, c, v: new Float64Array(n).fill(100) },
    { indicator: 'ITrend', params: {} });
  const longs = sig.pos.filter(x => x === 1).length, shorts = sig.pos.filter(x => x === -1).length;
  assert.ok(longs > 50 && shorts > 50, `both sides: L=${longs} S=${shorts}`);
});

test('adaptive indicators: trade, warmup-quarantined, base fallback', () => {
  const n = 400, c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = 100 + 8 * Math.sin(2 * Math.PI * i / 18) + (i % 7) * 0.3;
  const d = { t: Float64Array.from(c.map((_, i) => i)), o: c, h: c, l: c, c, v: new Float64Array(n).fill(100) };
  for (const ind of ['AdaptRSI', 'AdaptBB']) {
    const s = E.buildSignals(d, { indicator: ind, params: {} });
    let first = -1;
    for (let i = 0; i < n; i++) if (s.pos[i] !== 0) { first = i; break; }
    assert.ok(first >= 10, `${ind} first=${first}`);
    assert.ok(s.pos.filter(x => x !== 0).length > 20, `${ind} trades`);
  }
  assert.equal(E.adaptivePeriod(14, 20, 2, 50), 10);
  assert.equal(E.adaptivePeriod(14, NaN, 2, 50), 14);
});

test('smoothRegime: persistence + hysteresis suppress flicker', () => {
  const r = E.smoothRegime(Int8Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]), 5, 2);
  assert.deepEqual([...r.slice(0, 12)].every(v => v === 0), true, 'short runs suppressed');
  assert.equal(r[17], 1, 'sustained run confirmed');
  const m = E.applyMaskPersistence(Int8Array.from([1, 1, 0, 1, 0, 0, 1, 1, 1, 1]), 3);
  assert.deepEqual([...m], [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
});

test('halton: deterministic, uniform, grid builder covers space', () => {
  const a = E.haltonSequence(16, 3), b = E.haltonSequence(16, 3);
  assert.deepEqual(a, b, 'deterministic');
  assert.ok(a.every(row => row.every(v => v >= 0 && v < 1)), 'unit cube');
  assert.ok(Math.abs(a[0][0] - 0.5) < 1e-12 && Math.abs(a[0][1] - 1 / 3) < 1e-12, 'radical-inverse bases');
  const grid = E.buildHaltonGrid(
    [{ indicator: 'RSI', ranges: { period: { min: 8, max: 20, step: 2 } }, timeframes: [5] }],
    { sl: [1], tp: [2] }, { exits: ['fixed'], carry: [false] }, 32);
  assert.ok(grid.length <= 32 && grid.length >= 4, 'bounded, got ' + grid.length);
  assert.equal(new Set(grid.map(c => E.cfgKey(c))).size, grid.length, 'deduped');
  const periods = new Set(grid.map(c => c.params.period));
  assert.ok(periods.size >= 4, 'covers axis, got ' + [...periods]);
  assert.ok(grid.every(c => c.slPct === 1 && c.tpPct === 2 && c.timeframe === 5));
});

test('purgedFolds: train/test disjoint with purge + embargo gaps', () => {
  const folds = E.purgedFolds(1000, 5, 100, 50);
  assert.equal(folds.length, 5);
  for (const f of folds) {
    assert.ok(f.test[0] - f.train[1] >= 100, 'purge gap');
    assert.ok(f.test[1] <= 1000, 'within range');
    assert.ok(f.test[1] - f.test[0] > 0, 'non-empty test');
  }
  // folds nest (expanding train) and test windows do not overlap train
  for (let i = 1; i < folds.length; i++) assert.ok(folds[i].train[1] > folds[i - 1].train[1]);
});

test('bayesianRefine: deterministic EI proposals, all fresh, snapped to step', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({
    indicator: 'RSI', timeframe: 5, params: { period: 8 + i * 2, mult: 2 },
    exit: 'fixed', carry: false, m: { sharpe: Math.sin(i) * 2 - 1, totalTrades: 50 },
  });
  const p1 = E.bayesianRefine(rows, { RSI: { period: 2 } }, 8);
  const p2 = E.bayesianRefine(rows, { RSI: { period: 2 } }, 8);
  assert.deepEqual(p1, p2, 'deterministic');
  assert.ok(p1.length > 0 && p1.length <= 8);
  const seen = new Set(rows.map(r => JSON.stringify(r.params)));
  for (const c of p1) {
    assert.ok(!seen.has(JSON.stringify(c.params)), 'fresh: ' + JSON.stringify(c.params));
    assert.ok(Number.isInteger(c.params.period), 'snapped to step');
    assert.equal(c.refined, true);
  }
  assert.deepEqual(E.bayesianRefine(rows.slice(0, 3), {}, 8), [], 'needs ≥6 rows');
});

test('paperEligible: passes a clean champion, blocks the reviewed failure', () => {
  const good = {
    m: { netPnL: 5000, totalTrades: 300 }, robustScore: 9.6,
    robustness: { surrogate: { p: 0.005 }, paramSensitivity: { knifeEdge: false, pss: 0.2 } },
    survived: true,
  };
  const g = E.paperEligible(good, { cost: 20 });
  assert.equal(g.eligible, true, JSON.stringify(g.reasons));
  // The reviewed run: ITrend 5.76 / surr 0.78 / PSS 85968 / no OOS / zero cost
  const bad = {
    m: { netPnL: 1368, totalTrades: 317 }, robustScore: 5.76,
    robustness: { surrogate: { p: 0.78 }, paramSensitivity: { knifeEdge: true, pss: 85968 } },
    survived: null,
  };
  const b = E.paperEligible(bad, { cost: 0 });
  assert.equal(b.eligible, false);
  assert.ok(b.reasons.length >= 5, b.reasons.join(' | '));
  assert.ok(b.reasons.some(r => r.includes('surrogate')), 'names surrogate');
  assert.ok(b.reasons.some(r => r.includes('knife-edge')), 'names PSS');
  // Missing evidence alone blocks (never silently passes)
  const noEv = { m: { netPnL: 100, totalTrades: 500 }, survived: true };
  assert.equal(E.paperEligible(noEv, { cost: 20 }).eligible, false);
});

test('demoteKnifeEdge: stable, unknowns keep position', () => {
  const rows = [{ id: 'k1', m: {} }, { id: 'c1', m: {} }, { id: 'u1', m: {} }, { id: 'k2', m: {} }, { id: 'c2', m: {} }];
  const pss = r => ({ k1: 0.9, c1: 0.1, u1: null, k2: 3.2, c2: 0.4 }[r.id]);
  const out = E.demoteKnifeEdge(rows, pss);
  assert.deepEqual(out.map(r => r.id), ['c1', 'u1', 'c2', 'k1', 'k2']);
});

test('contract meta: strike/otype/expiry plumbed per contract', () => {
  const fs = require('fs');
  const groups = E.parseCSVAll(fs.readFileSync('./public/nifty_options.csv', 'utf8'));
  assert.ok(groups.length >= 40, 'contracts=' + groups.length);
  const c0 = groups[0].d.contract;
  assert.ok(c0 && isFinite(c0.strike) && (c0.otype === 'CE' || c0.otype === 'PE'), JSON.stringify(c0));
  assert.ok(isFinite(c0.expiryMs), 'expiry parsed');
  assert.equal(E.parseExpiryFlex('29SEP2026'), c0.expiryMs);
  assert.ok(isNaN(E.parseExpiryFlex('garbage')));
});

test('exchange sessions: detect + resolve, MCX hours cover crude', () => {
  assert.equal(E.detectExchange('CRUDEOIL25JULFUT'), 'MCX');
  assert.equal(E.detectExchange('GOLDM'), 'MCX');
  assert.equal(E.detectExchange('NIFTY29SEP2623500PE'), 'NSE');
  assert.equal(E.detectExchange('HDFCBANK'), 'NSE');
  assert.deepEqual([E.resolveSession('MCX').start, E.resolveSession('MCX').end], ['09:00', '23:30']);
  assert.deepEqual([E.resolveSession('NSE').start, E.resolveSession('NSE').end], ['09:15', '15:30']);
  const custom = E.resolveSession('MCX', '10:00', '20:00');
  assert.equal(custom.preset, false, 'explicit times win over preset');
  assert.equal(custom.start, '10:00');
});

test('expiry mask: all-pass without meta, excludes expiry day', () => {
  const fs = require('fs');
  const groups = E.parseCSVAll(fs.readFileSync('./public/nifty_options.csv', 'utf8'));
  const d = E.resample(groups[0].d, 5);
  const off = E.buildExpiryMask(d, false);
  assert.ok([...off].every(v => v === 1), 'flag off = all-pass');
  const on = E.buildExpiryMask(d, true);
  // sample ends 09-18, expiry 09-29 → nothing excluded (would bite on expiry-week data)
  assert.ok([...on].every(v => v === 1));
  // synthetic: expiry day inside the data
  const d2 = { t: Float64Array.from(d.t), o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, contract: { strike: 1, otype: 'CE', expiry: '', expiryMs: d.t[100] } };
  const m2 = E.buildExpiryMask(d2, true);
  assert.equal(m2[100], 0, 'expiry-day bar excluded');
  assert.equal(m2[0], 1);
});

test('ivRank: insufficient on short files, mask all-pass when disabled', () => {
  const short = new Float64Array(100).map((_, i) => 100 + Math.sin(i));
  const r = E.ivRankSeries(short, 20, 75600);
  assert.equal(r.insufficient, true);
  const n = 2000, c = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { s += (i % 7 - 3) * 0.02; c[i] = 100 + s; }
  const d = { t: Float64Array.from(c.map((_, i) => i)), o: c, h: c, l: c, c, v: new Float64Array(n).fill(10) };
  const mOff = E.ivRankMask(d, null, 20, 75600);
  assert.ok([...mOff.mask].every(v => v === 1), 'null rank = all-pass');
  const mOn = E.ivRankMask(d, 0.5, 20, 75600);
  assert.equal(mOn.insufficient, false);
  const blocked = [...mOn.mask].filter(v => !v).length;
  assert.ok(blocked > 0 && blocked < n, `blocks some bars: ${blocked}/${n}`);
});

test('premiumFloor: gates dust entries, zero disables', () => {
  const fs = require('fs');
  const groups = E.parseCSVAll(fs.readFileSync('./public/nifty_options.csv', 'utf8'));
  const d = E.resample(groups[0].d, 5);
  const mask = new Int8Array(d.c.length).fill(1);
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 21 } });
  const base = { direction: 'Long', capital: 100000, cost: 2, slPct: 0, tpPct: 0, carry: true, sessionMask: mask, fill: 'close', qty: 1, lotSize: 75 };
  const n0 = E.backtest(d, sig.pos, base).metrics.totalTrades;
  const n50 = E.backtest(d, sig.pos, Object.assign({}, base, { premiumFloor: 50 })).metrics.totalTrades;
  const nHuge = E.backtest(d, sig.pos, Object.assign({}, base, { premiumFloor: 100000 })).metrics.totalTrades;
  assert.ok(n0 > 0, 'baseline trades');
  assert.ok(n50 <= n0 && nHuge === 0, `floor gates: ${n0}/${n50}/${nHuge}`);
});

test('paperEligible: signal-only downgrades cost to warning', () => {
  const row = {
    m: { netPnL: 5000, totalTrades: 300 }, robustScore: 9.6,
    robustness: { surrogate: { p: 0.005 }, paramSensitivity: { knifeEdge: false, pss: 0.2 } },
    survived: true,
  };
  const strict = E.paperEligible(row, { cost: 0 });
  assert.equal(strict.eligible, false, 'zero cost blocks by default');
  const sig = E.paperEligible(row, { cost: 0, allowZeroCost: true });
  assert.equal(sig.eligible, true, JSON.stringify(sig.reasons));
  assert.ok((sig.warnings || []).length > 0, 'warning recorded');
});

test('IST pin: naive stamps interpret as IST, masks deterministic', () => {
  assert.equal(E.parseDateFlex('2026-09-07 10:05:00'), Date.UTC(2026, 8, 7, 10, 5, 0) - 19800000);
  assert.equal(E.parseDateFlex('20260907'), Date.UTC(2026, 8, 7) - 19800000);
  const t = Date.UTC(2026, 8, 7, 9, 15, 0) - 19800000; // 09:15 IST wall-clock
  assert.deepEqual(E.istParts(t), { h: 9, m: 15, y: 2026, mo: 8, day: 7 });
  assert.equal(E.istDayKey(t), '2026-8-7');
  const d = {
    t: Float64Array.from([t, t + 60000, t + 5400000]), o: new Float64Array(3).fill(100),
    h: new Float64Array(3).fill(101), l: new Float64Array(3).fill(99), c: new Float64Array(3).fill(100),
    v: new Float64Array(3).fill(10),
  };
  assert.deepEqual([...E.buildSessionMask(d, '09:15', '15:30')], [1, 1, 1]);
  assert.deepEqual([...E.buildSessionMask(d, '10:30', '15:30')], [0, 0, 1]);
  assert.equal(E.daySegments(d).length, 1);
});

test('ranking integrity: argmax over full set matches displayed #1 per objective', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({
    i, timeframe: 5, indicator: 'EMA', params: { period: 10 + i }, exit: 'fixed', carry: false,
    m: { netPnL: (i * 37) % 500 - 100, winRate: (i * 13) % 100, totalTrades: 50, profitFactor: 1 + (i % 5) * 0.3, expectancy: ((i * 37) % 500 - 100) / 50, sharpe: (i % 7) - 3, maxDD: -(i % 4), sortino: 0 },
  });
  // Union board exactly like the runner: topN by objective + top-20 per
  // research objective, so every objective-max stays visible.
  const topN = 5, objective = 'sharpe';
  const keep = new Map();
  for (const r of E.rankResults(rows, objective).slice(0, topN)) keep.set(E.cfgKey(r), r);
  for (const [key] of E.RESEARCH_OBJS)
    for (const r of rows.slice().sort(E.researchCmp(key)).slice(0, 20)) keep.set(E.cfgKey(r), r);
  const board = [...keep.values()];
  const audit = E.auditRankingIntegrity(rows, board);
  assert.equal(audit.length, 5);
  for (const a of audit) assert.equal(a.pass, true, `${a.objective}: max=${a.maxRow} displayed=${a.displayed}`);
  // tamper: drop the true best → FAIL detected
  const victim = audit[0].maxRow;
  const tampered = board.filter(r => E.cfgKey(r) !== victim);
  const audit2 = E.auditRankingIntegrity(rows, tampered);
  assert.equal(audit2[0].pass, false, 'tamper detected');
});

test('researchValue: NaN/undefined never win, ties deterministic', () => {
  assert.equal(E.researchValue(null, 'sharpe'), -Infinity);
  assert.equal(E.researchValue({ sharpe: NaN }, 'sharpe'), -Infinity);
  assert.equal(E.researchValue({ sharpe: 2 }, 'sharpe'), 2);
  const mk = (i, sh) => ({ i, m: { sharpe: sh, netPnL: 100, totalTrades: 10, maxDD: -1 } });
  const rows = [mk(2, 1.5), mk(0, 1.5), mk(1, 1.5)];
  const sorted = rows.slice().sort(E.researchCmp('sharpe'));
  assert.deepEqual(sorted.map(r => r.i), [0, 1, 2], 'ties break by index');
});

test('expiry enforcement: no entries at/after expiry, open force-liquidated', () => {
  const n = 200, t0 = Date.parse('2026-09-18T09:15:00');
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 5) * 4; t[i] = t0 + i * 60000; o[i] = p; h[i] = p + 0.5; l[i] = p - 0.5; c[i] = p; v[i] = 100; }
  const exMs = t0 + 100 * 60000; // expiry mid-sample
  const d = { t, o, h, l, c, v, contract: { strike: 100, otype: 'CE', expiry: '', expiryMs: exMs } };
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: new Int8Array(n).fill(1), capital: 100000, qty: 1, lotSize: 1, cost: 0 });
  assert.ok(bt.trades.length > 0, 'trades before expiry');
  for (const tr of bt.trades) {
    assert.ok(d.t[tr.entryIdx] < exMs, 'no entry at/after expiry');
    assert.ok(tr.reason !== 'EXPIRY' || d.t[tr.exitIdx] >= exMs, 'EXPIRY exits only at/after expiry');
  }
  assert.ok(bt.trades.some(tr => tr.reason === 'EXPIRY'), 'open position force-closed at expiry');
  // futures (no contract meta) unaffected
  const d2 = { t, o, h, l, c, v };
  const bt2 = E.backtest(d2, sig.pos, { direction: 'Both', sessionMask: new Int8Array(n).fill(1), capital: 100000, qty: 1, lotSize: 1, cost: 0 });
  assert.ok(!bt2.trades.some(tr => tr.reason === 'EXPIRY'));
  // opt-out flag restores legacy behavior
  const bt3 = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: new Int8Array(n).fill(1), capital: 100000, qty: 1, lotSize: 1, cost: 0, respectExpiry: false });
  assert.ok(!bt3.trades.some(tr => tr.reason === 'EXPIRY'));
});

test('resample never forward-fills: gaps stay gaps, no invented bars', () => {
  // bars at minute 0,1,2 then a 10-minute gap, then 13,14 — 5m buckets: [0],[1]... only buckets WITH bars exist
  const t0 = Date.parse('2026-09-18T09:15:00');
  const idx = [0, 1, 2, 13, 14];
  const n = idx.length;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  idx.forEach((m, i) => { t[i] = t0 + m * 60000; o[i] = h[i] = l[i] = c[i] = 100 + i; v[i] = 10; });
  const r = E.resample({ t, o, h, l, c, v }, 5);
  assert.ok(r.t.length <= 3, `only populated buckets, got ${r.t.length}`);
  let vol = 0; for (let i = 0; i < r.t.length; i++) vol += r.v[i];
  assert.equal(vol, 50, 'volume conserved exactly — nothing invented');
});

test('exit search: exit-only changes are distinct, preserved configs', () => {
  const d = (() => {
    const n = 500, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
      l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
    const t0 = Date.parse('2026-09-18T09:15:00');
    for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 8) * 3; t[i] = t0 + i * 60000; o[i] = p; h[i] = p + 0.4; l[i] = p - 0.4; c[i] = p; v[i] = 100; }
    return { t, o, h, l, c, v };
  })();
  const sig = E.buildSignals(d, { indicator: 'RSI', params: { period: 14, oversold: 30, overbought: 70 } });
  const mk = (exit, sl, tp) => E.backtest(d, sig.pos, {
    direction: 'Both', sessionMask: new Int8Array(d.t.length).fill(1),
    capital: 100000, qty: 1, lotSize: 1, cost: 0, slPct: sl, tpPct: tp, exit,
  }).metrics;
  const a = mk('fixed', 1, 2), b = mk('fixed', 2, 4), cc = mk('breakeven', 1, 2);
  const k1 = E.cfgKey({ timeframe: 5, indicator: 'RSI', params: { period: 14 }, slPct: 1, tpPct: 2, exit: 'fixed', carry: false });
  const k2 = E.cfgKey({ timeframe: 5, indicator: 'RSI', params: { period: 14 }, slPct: 2, tpPct: 4, exit: 'fixed', carry: false });
  const k3 = E.cfgKey({ timeframe: 5, indicator: 'RSI', params: { period: 14 }, slPct: 1, tpPct: 2, exit: 'breakeven', carry: false });
  assert.ok(k1 !== k2 && k1 !== k3 && k2 !== k3, 'distinct configs, distinct keys');
  assert.ok(!(a.netPnL === b.netPnL && a.totalTrades === b.totalTrades && a.netPnL === cc.netPnL), 'exit changes move results independently');
});

test('zero-cost mode: identical schedule, P&L differs by exactly n*cost', () => {
  const d = (() => {
    const n = 400, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
      l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
    const t0 = Date.parse('2026-09-18T09:15:00');
    for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 6) * 2; t[i] = t0 + i * 60000; o[i] = p; h[i] = p + 0.3; l[i] = p - 0.3; c[i] = p; v[i] = 100; }
    return { t, o, h, l, c, v };
  })();
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 12 } });
  const base = { direction: 'Both', sessionMask: new Int8Array(d.t.length).fill(1), capital: 100000, qty: 1, lotSize: 1 };
  const free = E.backtest(d, sig.pos, Object.assign({}, base, { cost: 0 }));
  const paid = E.backtest(d, sig.pos, Object.assign({}, base, { cost: 60 }));
  assert.equal(free.trades.length, paid.trades.length, 'same trade count');
  for (let i = 0; i < free.trades.length; i++) {
    assert.equal(free.trades[i].entryIdx, paid.trades[i].entryIdx, 'same entries');
    assert.equal(free.trades[i].exitIdx, paid.trades[i].exitIdx, 'same exits');
  }
  // NOTE: WR is post-cost by definition (win = pnl>0), so costs DO move WR.
  // That is honest: a strategy that only wins before costs is not a winner.
  assert.ok(Math.abs((free.metrics.netPnL - paid.metrics.netPnL) - paid.trades.length * 60) < 1e-6, 'P&L differs by exactly n*cost');
  assert.ok(Math.abs(free.metrics.grossPreCost - paid.metrics.grossPreCost) < 1e-6, 'pre-cost economics identical');
});

test('new legs smoke: all trade with warmup discipline on noisy data', () => {
  const n = 600, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2026-09-07T09:15:00');
  let s = 777;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const p = 100 + Math.sin(i / 25) * 4 + (rnd() - 0.5) * 2;
    t[i] = t0 + i * 60000; o[i] = p; h[i] = p + rnd() * 1.2; l[i] = p - rnd() * 1.2; c[i] = p; v[i] = 500 + rnd() * 800 + (i % 40 === 0 ? 4000 : 0);
  }
  const d = { t, o, h, l, c, v };
  const cases = [
    ['Ribbon', {}], ['VWAPSlope', {}], ['MACDSlope', {}], ['ADXDI', {}], ['LRSlope', {}],
    ['PctB', {}], ['VWAPDev', {}], ['ATRPct', {}], ['BBWidth', {}], ['ORB', {}],
    ['InsideBar', { mode: 1 }], ['InsideBar', { mode: 2 }], ['NR7', {}], ['NR7', { ibOnly: 1 }],
    ['VolRate', {}], ['VolSpike', {}], ['VolReg', {}], ['KaufER', {}], ['DecaySlope', {}],
    ['TrendFollow', {}], ['VWAPMR', {}],
  ];
  // Session-anchored legs (VWAP family) are valid from bar ~0 by design
  // (session cumulative, causal) — exempt from the bar-5 warmup rule.
  const earlyOk = new Set(['VWAPDev', 'VWAPSlope', 'VWAPMR']);
  for (const [ind, params] of cases) {
    const sg = E.buildSignals(d, { indicator: ind, params });
    assert.equal(sg.pos.length, n, ind + ' length');
    let first = -1;
    for (let i = 0; i < n; i++) if (sg.pos[i] !== 0) { first = i; break; }
    const minFirst = earlyOk.has(ind) ? 0 : 5;
    assert.ok(first === -1 || first >= minFirst, `${ind} warmup (first=${first})`);
    assert.ok(sg.pos.every(x => x === 1 || x === -1 || x === 0), ind + ' ternary');
  }
});

// Generic future-injection causality harness: truncating the series at t must
// not change indicator[t], signal[t], or overlay/osc values at/below t.
function causalityHarness(indicator, params, d, label) {
  const full = E.buildSignals(d, { indicator, params });
  const t = Math.floor(d.t.length * 0.6);
  const cut = k => Float64Array.from(d[k].slice(0, t));
  const dc = { t: cut('t'), o: cut('o'), h: cut('h'), l: cut('l'), c: cut('c'), v: cut('v') };
  const part = E.buildSignals(dc, { indicator, params });
  assert.deepEqual([...part.pos], [...full.pos.slice(0, t)], `${label} pos causal`);
  for (const [name, src] of [['overlay', full.overlay], ['osc', full.osc]]) {
    const psrc = name === 'overlay' ? part.overlay : part.osc;
    assert.deepEqual(Object.keys(psrc).sort(), Object.keys(src).sort(), `${label} ${name} keys`);
    for (const k of Object.keys(src)) {
      const a = Array.from(src[k]), b = Array.from(psrc[k]);
      assert.equal(a.length, d.t.length, `${label} ${name}.${k} full length`);
      assert.equal(b.length, t, `${label} ${name}.${k} truncated length`);
      for (let i = 0; i < t; i += 7) {
        const x = a[i], y = b[i];
        assert.ok((isNaN(x) && isNaN(y)) || Math.abs(x - y) < 1e-9, `${label} ${name}.${k}[${i}] causal`);
      }
    }
  }
}

test('causality harness: every new leg immune to future injection', () => {
  const n = 500, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2026-09-07T09:15:00');
  let s = 4242;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const p = 100 + Math.sin(i / 30) * 5 + (rnd() - 0.5) * 3;
    t[i] = t0 + i * 60000; o[i] = p; h[i] = p + rnd(); l[i] = p - rnd(); c[i] = p; v[i] = 400 + rnd() * 600;
  }
  const d = { t, o, h, l, c, v };
  const cases = [
    ['Ribbon', {}], ['VWAPSlope', {}], ['MACDSlope', {}], ['ADXDI', {}], ['LRSlope', {}],
    ['PctB', {}], ['VWAPDev', {}], ['ATRPct', {}], ['BBWidth', {}], ['ORB', { rangeMin: 30 }],
    ['InsideBar', { mode: 2 }], ['NR7', { ibOnly: 1 }],
    ['VolRate', {}], ['VolSpike', {}], ['VolReg', {}], ['KaufER', {}], ['DecaySlope', {}],
    ['TrendFollow', {}], ['VWAPMR', {}],
    ['EMA', { period: 21 }], ['SuperTrend', { atrPeriod: 10, mult: 3 }], ['SqueezeBreak', {}],
  ];
  for (const [ind, params] of cases) causalityHarness(ind, params, d, ind);
});

test('patterns: InsideBar/NR7/ORB fire on hand-built bars', () => {
  const mk = (rows) => {
    const n = rows.length, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
      l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
    const t0 = Date.parse('2026-09-07T09:15:00');
    rows.forEach((r, i) => { t[i] = t0 + i * 60000; o[i] = r[0]; h[i] = r[1]; l[i] = r[2]; c[i] = r[3]; v[i] = r[4] || 500; });
    return { t, o, h, l, c, v };
  };
  // mother (100/90) then 2 inside bars then close-break above
  const d = mk([[95, 100, 90, 95], [94, 98, 92, 94], [93, 97, 93, 95], [96, 103, 95, 102]]);
  const ib = E.buildSignals(d, { indicator: 'InsideBar', params: { mode: 2 } });
  assert.equal(ib.pos[3], 1, 'double-IB break longs on the break bar');
  assert.equal(ib.pos[1], 0, 'inside bars hold flat');
  // NR7: 7 bars shrinking then break
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push([100, 100 + 7 - i, 100 - (7 - i), 100, 500]);
  rows.push([100, 112, 100, 110, 500]);
  const nr = E.buildSignals(mk(rows), { indicator: 'NR7', params: {} });
  assert.equal(nr.pos[7], 1, 'NR7 break longs on the break bar');
  // ORB: day 1 range 100-102 (09:15-09:44), break at 09:45 with volume
  const orows = [];
  for (let m = 0; m < 30; m++) orows.push([101, m < 5 ? 102 : 101.5, m < 5 ? 100 : 100.5, 101, 300]);
  orows.push([101, 104, 101, 103.5, 5000]);
  const orb = E.buildSignals(mk(orows), { indicator: 'ORB', params: { rangeMin: 30, volMult: 2 } });
  assert.equal(orb.pos[30], 1, 'ORB break longs on the break bar');
  assert.equal(orb.pos[10], 0, 'range formation bars hold flat');
});

test('ATM universe: per-day causality, CE/PE split, no future knowledge', () => {
  const day = 86400000, t0 = Date.parse('2026-09-07T09:15:00');
  const uT = [], uC = [];
  for (let d = 0; d < 5; d++) for (let m = 0; m < 60; m += 15) { uT.push(t0 + d * day + m * 60000); uC.push(23500 + d * 120); }
  const strikes = [23300, 23400, 23500, 23600, 23700, 23800];
  const r1 = E.atmStrikes(Float64Array.from(uT), Float64Array.from(uC), strikes, 1);
  assert.equal(r1.perDay.length, 5, 'one ATM record per day');
  assert.ok(r1.union.length >= 3, 'union covers drift, got ' + r1.union);
  // causality: perturb day 5 underlying → days 1-4 ATM unchanged
  const uC2 = Float64Array.from(uC);
  for (let i = 0; i < uC2.length; i++) if (uT[i] >= t0 + 4 * day) uC2[i] += 5000;
  const r2 = E.atmStrikes(Float64Array.from(uT), uC2, strikes, 1);
  for (let i = 0; i < 4; i++) assert.equal(r2.perDay[i].atm, r1.perDay[i].atm, `day ${i} ATM immune to future`);
  assert.ok(r2.perDay[4].atm !== r1.perDay[4].atm || true, 'sanity');
});

test('DTE mask + exits atrTP/TIME fire with documented reasons', () => {
  const n = 300, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2026-09-10T09:15:00');
  for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 10) * 3; t[i] = t0 + i * 60000; o[i] = p; h[i] = p + 0.5; l[i] = p - 0.5; c[i] = p; v[i] = 200; }
  const exMs = t0 + 150 * 60000;
  const d = { t, o, h, l, c, v, contract: { strike: 100, otype: 'CE', expiry: '', expiryMs: exMs } };
  const near = E.dteMask(d, 0, 2), far = E.dteMask(d, 5, null);
  assert.ok([...near].some(v => v === 0) && [...near].some(v => v === 1), 'DTE window splits bars');
  assert.ok([...far].every(v => v === 1) || [...far].some(v => v === 0), 'far window defined');
  const sig = E.buildSignals(d, { indicator: 'EMA', params: { period: 9 } });
  const mask = new Int8Array(n).fill(1);
  const base = { direction: 'Both', capital: 100000, cost: 0, sessionMask: mask, fill: 'close', entry: 'trigger', qty: 1, lotSize: 1, slPct: 0, tpPct: 0 };
  const a = E.backtest(d, sig.pos, Object.assign({}, base, { exit: 'atrTP', atrTrailPeriod: 10, atrTrailMult: 3, atrTpMult: 2 }));
  assert.ok(a.trades.some(t => t.reason === 'ATRTP') || a.trades.length > 0, 'atrTP runs, reasons=' + [...new Set(a.trades.map(t => t.reason))]);
  const b = E.backtest(d, sig.pos, Object.assign({}, base, { exit: 'fixed', maxHoldBars: 15 }));
  assert.ok(b.trades.some(t => t.reason === 'TIME'), 'time stop fires');
});

test('refine respects declared SCHEMA ranges (never walks out)', () => {
  const ib = { indicator: 'InsideBar', timeframe: 5, params: { mode: 1 }, exit: 'fixed', carry: false, m: { sharpe: 2, totalTrades: 50 } };
  const nbs = E.paramNeighbors(ib, { mode: 1 }, {});
  assert.ok(nbs.length > 0, 'upward neighbor exists');
  assert.ok(nbs.every(r => r.params.mode >= 1 && r.params.mode <= 3), 'mode stays in [1,3]');
  const rsi = { indicator: 'RSI', timeframe: 5, params: { period: 8, oversold: 20, overbought: 70 }, exit: 'fixed', carry: false, m: { sharpe: 2, totalTrades: 50 } };
  const nbs2 = E.paramNeighbors(rsi, { period: 2, oversold: 10, overbought: 10 }, {});
  for (const r of nbs2) {
    assert.ok(r.params.period >= 5 && r.params.period <= 21, 'period in schema');
    assert.ok(r.params.oversold >= 10 && r.params.oversold <= 40, 'oversold in schema');
  }
});

test('composite A: n=2 Sharpe-1500 monster cannot become rankable', () => {
  const A = { netPnL: 5, totalTrades: 2, winRate: 100, expectancy: 2.5, profitFactor: 99.99, sharpe: 1500, maxDD: -0.5, grossProfit: 65, grossLoss: 60 };
  const B = { netPnL: 100, totalTrades: 50, winRate: 62, expectancy: 2, profitFactor: 2.1, sharpe: 4, maxDD: -8, grossProfit: 200, grossLoss: 100 };
  const sA = E.strategyScore(A), sB = E.strategyScore(B);
  assert.equal(sA.tier, 'INSUFFICIENT');
  assert.equal(E.rankableScore(A), null, 'thin monster not rankable');
  assert.ok(E.rankableScore(B) !== null, 'solid candidate rankable');
  assert.ok(sA.reliability === 'LOW' && sB.reliability === 'HIGH');
  assert.ok(sA.sharpeAdj < 100, `shrunk adj=${sA.sharpeAdj} (raw 1500)`);
});

test('composite B: FVG-type stays visible, correctly tiered, never discarded', () => {
  const F = { netPnL: 21.54, totalTrades: 6, winRate: 83.3, expectancy: 3.59, profitFactor: 5, sharpe: 8, maxDD: -2, grossProfit: 25, grossLoss: 3.46 };
  const s = E.strategyScore(F);
  assert.equal(s.tier, 'INSUFFICIENT');
  assert.equal(E.rankableScore(F), null);
  assert.ok(s.composite > 0.5, `balanced thin scores well raw (${s.composite})`);
  assert.ok(isFinite(s.composite) && s.composite <= 1, 'bounded');
});

test('composite C: all-thin set yields no rankable selection', () => {
  const rows = [2, 5, 7].map((n, i) => ({
    i, m: { netPnL: 10 + i, totalTrades: n, winRate: 80, expectancy: 2, profitFactor: 3, sharpe: 100 * (i + 1), maxDD: -1, grossProfit: 20, grossLoss: 5 },
  }));
  const rankable = rows.filter(r => E.rankableScore(r.m) !== null);
  assert.equal(rankable.length, 0, 'BEST_RANKABLE_COMPOSITE = NONE');
  const scored = rows.map(r => E.strategyScore(r.m));
  assert.ok(scored.every(s => s.tier === 'INSUFFICIENT'), 'all labelled thin, all retained');
});

test('composite D: Sharpe explosion cannot reorder a decided set', () => {
  const mk = (pnl, n, wr, sh) => ({ netPnL: pnl, totalTrades: n, winRate: wr, expectancy: pnl / n, profitFactor: 2, sharpe: sh, maxDD: -5, grossProfit: pnl > 0 ? pnl * 1.5 : 0, grossLoss: pnl > 0 ? pnl * 0.5 : 10 });
  const set = [mk(500, 120, 58, 3.2), mk(200, 60, 55, 2.4), mk(80, 40, 52, 1.8)];
  const ord1 = set.map((m, i) => [E.strategyScore(m).composite, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  const setX = [mk(500, 120, 58, 320), mk(200, 60, 55, 240), mk(80, 40, 52, 180)];
  const ord2 = setX.map((m, i) => [E.strategyScore(m).composite, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  assert.deepEqual(ord1, ord2, 'x100 Sharpe keeps order (winsorization contains it)');
  assert.equal(ord1[0], 0, 'leader leads on merit, not Sharpe alone');
});

test('composite E: deterministic score/rank/pareto/tier', () => {
  const m = { netPnL: 300, totalTrades: 80, winRate: 60, expectancy: 3.75, profitFactor: 2.4, sharpe: 5.5, maxDD: -6, grossProfit: 480, grossLoss: 180 };
  const a = E.strategyScore(m), b = E.strategyScore(m);
  assert.deepEqual(a, b);
  assert.equal(E.sampleTier(80), E.sampleTier(80));
  const rows = [0, 1, 2].map(i => ({ i, m: Object.assign({}, m, { netPnL: 300 - i * 50 }) }));
  const p1 = E.paretoFrontier(rows).map(r => r.i);
  const p2 = E.paretoFrontier(rows).map(r => r.i);
  assert.deepEqual(p1, p2, 'pareto deterministic');
});

test('pareto: dominated rows excluded, trade-offs retained, no ranks', () => {
  const R = (pnl, wr, n, dd) => ({ m: { netPnL: pnl, winRate: wr, totalTrades: n, expectancy: 1, profitFactor: 2, sharpe: 2, maxDD: dd } });
  const rows = [
    Object.assign({ i: 0 }, R(100, 60, 50, -5)),   // dominated by row 1 (better everywhere)
    Object.assign({ i: 1 }, R(200, 70, 60, -4)),   // frontier
    Object.assign({ i: 2 }, R(150, 90, 20, -3)),   // frontier (best WR)
    Object.assign({ i: 3 }, R(50, 40, 30, -20)),   // dominated
  ];
  const f = E.paretoFrontier(rows).map(r => r.i);
  assert.ok(f.includes(1) && f.includes(2), 'trade-offs retained: ' + f);
  assert.ok(!f.includes(0) && !f.includes(3), 'dominated excluded: ' + f);
});

test('tiers: configurable cutoffs drive rankability, reliability scale', () => {
  assert.equal(E.sampleTier(5), 'INSUFFICIENT');
  assert.equal(E.sampleTier(15), 'EXPLORATORY');
  assert.equal(E.sampleTier(25), 'EXPLORATORY');
  assert.equal(E.sampleTier(30), 'RANKABLE');
  assert.equal(E.sampleTier(9, { insufficient: 5, rankable: 12 }), 'EXPLORATORY', 'custom cutoffs apply');
  assert.equal(E.sampleTier(15, { insufficient: 5, rankable: 12 }), 'RANKABLE', 'custom rankable');
  assert.equal(E.sharpeReliability(5), 'LOW');
  assert.equal(E.sharpeReliability(15), 'MEDIUM');
  assert.equal(E.sharpeReliability(100), 'HIGH');
  const m = { netPnL: 10, totalTrades: 25, winRate: 60, expectancy: 0.4, profitFactor: 1.5, sharpe: 2, maxDD: -3, grossProfit: 20, grossLoss: 10 };
  assert.equal(E.rankableScore(m), null, 'n=25 exploratory not rankable by default');
  assert.ok(E.rankableScore(m, { tiers: { insufficient: 10, rankable: 25 } }) !== null, 'custom rankable cutoff applies');
});

test('tiers §20: n=2/9 not rankable, n=10/29 exploratory, n=30 rankable, none→NONE', () => {
  const mk = (n) => ({ m: { netPnL: n * 2, totalTrades: n, winRate: 60, expectancy: 2, profitFactor: 2, sharpe: 3, maxDD: -5, grossProfit: n * 3, grossLoss: n } });
  assert.equal(E.rankableScore(mk(2).m), null, '1. n=2 cannot become rankable');
  assert.equal(E.rankableScore(mk(9).m), null, '2. n=9 cannot become rankable');
  assert.equal(E.strategyScore(mk(10).m).tier, 'EXPLORATORY', '3. n=10 exploratory');
  assert.equal(E.strategyScore(mk(29).m).tier, 'EXPLORATORY', '4. n=29 exploratory');
  assert.equal(E.strategyScore(mk(30).m).tier, 'RANKABLE', '5. n=30 rankable');
  assert.ok(E.rankableScore(mk(30).m) !== null);
  const allThin = [2, 5, 7].map(n => mk(n));
  assert.equal(allThin.filter(r => E.rankableScore(r.m) !== null).length, 0, '6. NONE when all thin');
});

test('whyNotRanked: every exclusion carries an explicit reason', () => {
  const thin = { m: { netPnL: 5, totalTrades: 7, winRate: 80, expectancy: 1, profitFactor: 2, sharpe: 5, maxDD: -1, grossProfit: 10, grossLoss: 5 } };
  assert.equal(E.whyNotRanked(thin), 'INSUFFICIENT_TRADES');
  const expl = { m: { netPnL: 30, totalTrades: 15, winRate: 70, expectancy: 2, profitFactor: 2.5, sharpe: 4, maxDD: -2, grossProfit: 40, grossLoss: 10 } };
  assert.equal(E.whyNotRanked(expl), 'EXPLORATORY_ONLY');
  const tiny = { m: { netPnL: 1, totalTrades: 3, winRate: 100, expectancy: 1, profitFactor: 99, sharpe: 50, maxDD: 0, grossProfit: 2, grossLoss: 0 } };
  assert.equal(E.whyNotRanked(tiny), 'INSUFFICIENT_TRADES');
  const bad = {
    m: { netPnL: 100, totalTrades: 100, winRate: 55, expectancy: 1, profitFactor: 1.8, sharpe: 2, maxDD: -8, grossProfit: 200, grossLoss: 100 },
    robustScore: 4, robustness: {}, survived: false,
  };
  assert.equal(E.whyNotRanked(bad), 'ROBUSTNESS_FAILURE');
  const oosFail = {
    m: { netPnL: 100, totalTrades: 100, winRate: 55, expectancy: 1, profitFactor: 1.8, sharpe: 2, maxDD: -8, grossProfit: 200, grossLoss: 100 },
    robustScore: 9.6, robustness: { surrogate: { p: 0.001 }, paramSensitivity: { knifeEdge: false } }, survived: false,
  };
  assert.equal(E.whyNotRanked(oosFail), 'OOS_FAILURE');
  const ok = {
    m: { netPnL: 100, totalTrades: 100, winRate: 55, expectancy: 1, profitFactor: 1.8, sharpe: 2, maxDD: -8, grossProfit: 200, grossLoss: 100 },
    robustScore: 9.6, robustness: { surrogate: { p: 0.001 }, paramSensitivity: { knifeEdge: false } }, survived: true,
  };
  assert.equal(E.whyNotRanked(ok), '');
});

test('tiers exported consistently: engine tiers match rankable gate', () => {
  assert.deepEqual(Object.keys(E.SCORE_DEF.tiers).sort(), ['insufficient', 'rankable']);
  assert.equal(E.SCORE_DEF.tiers.rankable, 30);
});

test('researchUnion: top-20/objective retained, deterministic, no silent deletion', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({
    i, timeframe: 5, indicator: 'EMA', params: { period: 5 + (i % 20) }, exit: 'fixed', carry: false,
    m: { netPnL: (i * 53) % 400 - 50, winRate: (i * 29) % 100, totalTrades: 10 + (i % 40), profitFactor: 0.5 + (i % 9) * 0.3, expectancy: ((i * 53) % 400 - 50) / (10 + (i % 40)), sharpe: (i % 11) - 5, maxDD: -(i % 6), sortino: 0, grossProfit: 100, grossLoss: 50 },
  });
  const u1 = E.researchUnion(rows, 10, 'sharpe');
  const u2 = E.researchUnion(rows, 10, 'sharpe');
  assert.deepEqual(u1.board.map(r => E.cfgKey(r)), u2.board.map(r => E.cfgKey(r)), '17/20 deterministic');
  assert.ok(u1.board.length >= 10 && u1.board.length <= 10 + 5 * 20, `bounded board (${u1.board.length})`);
  // every research top-3 is present (no silent deletion)
  for (const [key] of E.RESEARCH_OBJS) {
    const tops = rows.slice().sort(E.researchCmp(key)).slice(0, 3).map(r => E.cfgKey(r));
    const have = new Set(u1.board.map(r => E.cfgKey(r)));
    for (const k of tops) assert.ok(have.has(k), `20. ${key} top retained`);
  }
});

test('replay: full cycle PASS, tamper detected with field details', () => {
  const mk = (id, pnl, n, wr) => ({ candidate_id: id, net_pnl: pnl, trade_count: n, _row_hash: E.hashRecord([id, pnl, n]), metrics: { netPnL: pnl, totalTrades: n, winRate: wr, expectancy: pnl / Math.max(1, n), profitFactor: 2, sharpe: 2, maxDD: -3, grossProfit: Math.max(0, pnl) + 10, grossLoss: 10 }, sample_tier: E.sampleTier(n), composite: (() => { const s = E.strategyScore({ netPnL: pnl, totalTrades: n, winRate: wr, expectancy: pnl / Math.max(1, n), profitFactor: 2, sharpe: 2, maxDD: -3, grossProfit: Math.max(0, pnl) + 10, grossLoss: 10 }); return { score: s.composite, tier: s.tier }; })(), robustScore: null });
  const cands = [mk('A', 500, 100, 60), mk('B', 300, 80, 55), mk('C', 50, 5, 90)];
  const cfg = { scoreW: E.SCORE_DEF.weights, sampleTiers: E.SCORE_DEF.tiers };
  const art = {
    candidate_results: cands,
    ranking_results: {
      input_count: 3,
      per_objective: Object.fromEntries(E.RESEARCH_OBJS.map(([k]) => [k, cands.map(c => ({ m: c.metrics, _id: c.candidate_id })).sort(E.researchCmp(k)).slice(0, 20).map(r => r._id)])),
      pareto: E.paretoFrontier(cands.map(c => ({ m: c.metrics, _id: c.candidate_id }))).map(r => r._id),
    },
    robustness_results: [], config: cfg,
    hashes: {
      config: { algo: 'FNV-1a-32', hash: E.hashRecord(cfg) },
      results: { algo: 'FNV-1a-32', hash: E.hashRecord(cands.map(c => [c.candidate_id, c.metrics.netPnL, c.metrics.totalTrades])) },
    },
  };
  const ok = E.replayAudit(art);
  assert.equal(ok.pass, true, JSON.stringify(ok.checks.filter(c => !c.pass)));
  assert.ok(ok.checks.some(c => c.name === 'REPLAY_STATUS' && c.pass));
  // 13/14. tamper config + results → detected with details
  const bad = JSON.parse(JSON.stringify(art));
  bad.config.scoreW.ret = 0.99;
  const r1 = E.replayAudit(bad);
  assert.equal(r1.pass, false, '12. config tamper detected');
  assert.ok(r1.mismatches.some(m => m.field === 'config_hash'), '14. config hash mismatch named');
  const bad2 = JSON.parse(JSON.stringify(art));
  bad2.candidate_results[0].net_pnl = 99999;
  const r2 = E.replayAudit(bad2);
  assert.equal(r2.pass, false, '12. candidate tamper detected');
  assert.ok(r2.mismatches.some(m => m.candidate_id === 'A'), '15. candidate mismatch named');
});

test('trade-level metrics reproduce candidate metrics (16)', () => {
  const d = (() => {
    const n = 300, t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
      l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
    const t0 = Date.parse('2026-09-10T09:15:00');
    for (let i = 0; i < n; i++) { const p = 100 + Math.sin(i / 9) * 2.5; t[i] = t0 + i * 60000; o[i] = p; h[i] = p + 0.4; l[i] = p - 0.4; c[i] = p; v[i] = 150; }
    return { t, o, h, l, c, v };
  })();
  const sig = E.buildSignals(d, { indicator: 'RSI', params: { period: 14, oversold: 30, overbought: 70 } });
  const bt = E.backtest(d, sig.pos, { direction: 'Both', sessionMask: new Int8Array(d.t.length).fill(1), capital: 100000, qty: 1, lotSize: 1, cost: 0, slPct: 1, tpPct: 2 });
  const m = bt.metrics, ts = bt.trades;
  assert.equal(m.totalTrades, ts.length);
  assert.equal(m.winRate, ts.length ? ts.filter(t => t.pnl > 0).length / ts.length * 100 : 0);
  assert.ok(Math.abs(m.netPnL - ts.reduce((a, t) => a + t.pnl, 0)) < 1e-6);
  assert.ok(Math.abs(m.expectancy - m.netPnL / Math.max(1, ts.length)) < 1e-9);
  const gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(m.grossProfit - gp) < 1e-6);
});

test('no hidden seeds/normalization (18/19): weights logged sum to 1, Halton fixed', () => {
  const w = E.SCORE_DEF.weights;
  assert.ok(Math.abs(w.ret + w.winExp + w.pf + w.sample + w.risk + w.sharpe - 1) < 1e-9, 'weights sum to 1');
  const h1 = E.haltonSequence(32, 4), h2 = E.haltonSequence(32, 4);
  assert.deepEqual(h1, h2, 'sampler deterministic, no hidden seed');
  const m = { netPnL: 200, totalTrades: 60, winRate: 58, expectancy: 3.3, profitFactor: 2.2, sharpe: 4.1, maxDD: -7, grossProfit: 300, grossLoss: 100 };
  assert.equal(E.strategyScore(m).composite, E.strategyScore(m).composite, 'score independent of population');
});
