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
