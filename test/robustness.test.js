/* XBOST robustness unit tests (run: npm test). Needs the browser-like global
   that engine.js/robustness.js share via `self` in workers. */
'use strict';
globalThis.self = globalThis;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');
const R = require('../public/robustness.js');

function bars(n, fn) {
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n),
    l = new Float64Array(n), c = new Float64Array(n), v = new Float64Array(n);
  const t0 = Date.parse('2024-01-02T09:15:00');
  for (let i = 0; i < n; i++) { const b = fn(i); t[i] = t0 + i * 60000; o[i] = b[0]; h[i] = b[1]; l[i] = b[2]; c[i] = b[3]; v[i] = b[4] || 1000; }
  return { t, o, h, l, c, v };
}
const ones = n => new Int8Array(n).fill(1);

test('paramSensitivity: structure, determinism, no-param indicator is flat', () => {
  const d = bars(400, i => { const p = 100 + 6 * Math.sin(2 * Math.PI * i / 24); return [p, p + 0.5, p - 0.5, p, 500]; });
  const opts = { direction: 'Both', sessionMask: ones(400), slPct: 1, tpPct: 2, capital: 100000, qty: 1, lotSize: 1, cost: 0 };
  const a = R.paramSensitivity(d, 'RSI', { period: 14, oversold: 30, overbought: 70 }, opts);
  const b = R.paramSensitivity(d, 'RSI', { period: 14, oversold: 30, overbought: 70 }, opts);
  assert.deepEqual(a, b, 'deterministic');
  assert.ok(isFinite(a.pss) && a.pss >= 0, 'pss finite');
  assert.equal(typeof a.knifeEdge, 'boolean');
  assert.deepEqual(Object.keys(a.perParam).sort(), ['overbought', 'oversold', 'period']);
  const flat = R.paramSensitivity(d, 'VWAP', {}, opts);
  assert.equal(flat.pss, 0, 'param-free indicator has zero curvature');
  assert.equal(flat.knifeEdge, false);
});

test('blockBootstrapCI: deterministic, shaped, insufficient-trades note', () => {
  const trades = [];
  let s = 42;
  for (let i = 0; i < 120; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; trades.push({ pnl: (s / 0x7fffffff - 0.45) * 100 }); }
  const a = R.blockBootstrapCI(trades, 20, 200, 7);
  const b = R.blockBootstrapCI(trades, 20, 200, 7);
  assert.deepEqual(a, b, 'seeded deterministic');
  assert.ok(a.sharpe[0] <= a.sharpe[1] && a.wr[0] <= a.wr[1], 'ordered CIs');
  assert.equal(a.nSamples, 200);
  assert.equal(a.status, 'OK');
  assert.equal(a.method, 'block');
  assert.equal(a.block, 20);
  assert.equal(a.seed, 7);
  assert.equal(a.n, 120);
  const thin = R.blockBootstrapCI(trades.slice(0, 5), 20, 200, 7);
  assert.equal(thin.status, 'SKIPPED', 'thin trade list refused with status');
  assert.equal(thin.reason, 'INSUFFICIENT_SAMPLE');
  assert.equal(thin.sharpe, null, 'skipped CI is null, never [0,0]');
  assert.equal(thin.wr, null);
  assert.equal(thin.pf, null);
});

test('surrogateTest: noise ≈ 0.5, deterministic, thin refused', () => {
  const rnd = [];
  let s = 1234;
  for (let i = 0; i < 200; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rnd.push({ pnl: (s / 0x7fffffff - 0.5) * 100 }); }
  const p1 = R.surrogateTest(rnd, 50, 7).p;
  const p2 = R.surrogateTest(rnd, 50, 7).p;
  assert.equal(p1, p2, 'seeded deterministic');
  assert.ok(p1 > 0.2 && p1 < 0.8, `noise p≈0.5, got ${p1}`);
  assert.equal(R.surrogateTest(rnd.slice(0, 10), 50, 7).nSurr, 0, 'thin refused');
});

test('freeParamCount: signal params + active risk knobs', () => {
  assert.equal(R.freeParamCount({ params: { period: 20, mult: 2 }, slPct: 1, tpPct: 2 }), 4);
  assert.equal(R.freeParamCount({ params: { period: 20 } }), 1);
  assert.equal(R.freeParamCount({ params: {} }), 0);
});

test('paramSensitivity: thin samples skip (curvature meaningless), Sharpe winsorized', () => {
  const d = bars(120, i => { const p = 100 + i * 0.05; return [p, p + 0.2, p - 0.2, p, 500]; });
  const opts = { direction: 'Both', sessionMask: ones(120), slPct: 0, tpPct: 0, capital: 100000, qty: 1, lotSize: 1, cost: 0 };
  const s = R.paramSensitivity(d, 'EMA', { period: 21 }, opts);
  assert.equal(s.skipped, true, 'thin EMA run must skip, got pss=' + s.pss);
  assert.equal(s.knifeEdge, false, 'skip never reports knife-edge');
});

test('effOptsFor mirrors board execution; baseline reproduces board metrics', () => {
  const fs = require('fs');
  const groups = E.parseCSVAll(fs.readFileSync('./public/nifty_options.csv', 'utf8'));
  const d = E.resample(groups[0].d, 5);
  const mask = new Int8Array(d.c.length).fill(1);
  const baseOpts = {
    direction: 'Both', capital: 100000, cost: 60, slPct: 0.8, tpPct: 1.6,
    carry: false, sessionMask: mask, fill: 'next', entry: 'trigger', qty: 1, lotSize: 75,
  };
  // Board-style evaluation with an optimized (non-default) config
  const cand = { indicator: 'Bollinger', params: { period: 20, mult: 2 }, slPct: 2.5, tpPct: 1, exit: 'breakeven', carry: true };
  const sig = E.buildSignals(d, { indicator: cand.indicator, params: cand.params });
  const boardBt = E.backtest(d, sig.pos, Object.assign({}, baseOpts, {
    slPct: cand.slPct, tpPct: cand.tpPct, exit: cand.exit, carry: cand.carry,
    sessionMask: E.sessionMaskFor(d, Object.assign({}, baseOpts, { carry: true })),
  }));
  // Robustness-style evaluation through effOptsFor must match exactly
  R.clearCache();
  const eff = R.effOptsFor(cand, baseOpts, d);
  assert.equal(eff.slPct, 2.5, 'candidate SL applied');
  assert.equal(eff.tpPct, 1, 'candidate TP applied');
  assert.equal(eff.exit, 'breakeven', 'candidate exit applied');
  assert.equal(eff.carry, true, 'candidate carry applied');
  const rb = E.backtest(d, E.buildSignals(d, { indicator: cand.indicator, params: cand.params }).pos, eff);
  for (const k of ['netPnL', 'winRate', 'totalTrades', 'profitFactor', 'sharpe', 'expectancy']) {
    assert.ok(Math.abs(rb.metrics[k] - boardBt.metrics[k]) < 1e-9, `${k}: robust=${rb.metrics[k]} board=${boardBt.metrics[k]}`);
  }
});
