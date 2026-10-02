/* OPTION DISCOVERY engine unit tests (run: npm test). Pure logic, no DOM.
   Covers: schema detection (long/wide/renamed), chain metadata, features,
   relationships, backtest fingerprint + exit propagation, metric integrity,
   no-hardcode rule, and a full end-to-end run on the 2-day sample file. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const OD = require('../public/discovery-engine.js');

function synth(otypes, ncol) {
  // deterministic long-form CSV: 2 strikes x otypes x 400 bars
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lines = ['ts,exp,strike_px,cp,sym,o,h,l,c,v'];
  const t0 = Date.parse('2026-01-05T09:15:00Z');
  for (let b = 0; b < 400; b++) {
    for (const s of [100, 200]) for (const o of otypes) {
      const px = 100 + Math.sin(b / 9) * 3 + (rnd() - 0.5) * 2;
      lines.push([new Date(t0 + b * 60000).toISOString(), 'E1', s, o, `U${s}${o}`,
        px.toFixed(2), (px + 0.5).toFixed(2), (px - 0.5).toFixed(2),
        (px + (rnd() - 0.5)).toFixed(2), 100].join(','));
    }
  }
  void ncol;
  return lines.join('\n');
}

test('schema detect: renamed long columns (ts/cp/o/h/l/c/v)', () => {
  const { norm, layout } = OD.ingest(synth(['C', 'P']));
  assert.equal(layout, 'long');
  assert.ok(norm.length > 1000);
  assert.deepEqual([...new Set(norm.map(r => r.option_type))].sort(), ['C', 'P']);
});

test('schema detect: wide format with custom tokens', () => {
  const t0 = Date.parse('2026-02-02T09:15:00Z');
  const lines = ['ts,A_1_CALL_o,A_1_CALL_h,A_1_CALL_l,A_1_CALL_c,A_1_CALL_v,A_1_PUT_c,A_1_PUT_v'];
  for (let b = 0; b < 300; b++) lines.push([new Date(t0 + b * 60000).toISOString(), 10, 11, 9, 10, 5, 20, 6].join(','));
  const { norm, layout } = OD.ingest(lines.join('\n'));
  assert.equal(layout, 'wide');
  assert.equal(new Set(norm.map(r => r.symbol)).size, 2);
});

test('chain metadata is fully discovered (no fixed counts)', () => {
  const { norm } = OD.ingest(synth(['Call', 'Put']));
  const meta = OD.detectChain(norm);
  assert.equal(meta.n_strikes, 2);
  assert.deepEqual(meta.option_types, ['C', 'P']);
  assert.equal(meta.n_expiries, 1);
  assert.ok(meta.synchronized_snapshots > 100);
});

test('features are past-only (no lookahead)', () => {
  const { norm } = OD.ingest(synth(['CE', 'PE']));
  OD.features(norm.filter(r => r.symbol === norm[0].symbol).slice(0, 200));
  const arr = norm.filter(r => r.symbol === norm[0].symbol).slice(0, 200);
  // return_1 at bar 3 must equal close[3]/close[2]-1 exactly
  const e = arr[3].close / arr[2].close * 100 - 100;
  assert.ok(Math.abs(arr[3].return_1 - e) < 1e-9);
  // first bar has no history
  assert.ok(isNaN(arr[0].return_1));
});

test('exit propagation: different TP must diverge when reachable', () => {
  const { norm } = OD.ingest(synth(['CE', 'PE']));
  const rows = OD.features(norm.slice(0, 4000));
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const sig = [];
  for (const [s, arr] of bySym) for (let i = 0; i < Math.min(30, arr.length); i++) sig.push({ sym: s, i });
  const sums = [1, 2, 3].map(tp =>
    OD.backtest(bySym, sig, { cid: 'T', sl: 0.5, tp, trail: null, mode: 'premium', hold: 5 }).ledger
      .reduce((a, t) => a + t.ret, 0));
  assert.ok(!(sums[0] === sums[1] && sums[1] === sums[2]), 'identical TP pnl = propagation failure');
});

test('metric integrity: ledger recomputes', () => {
  const { norm } = OD.ingest(synth(['CE', 'PE']));
  const rows = OD.features(norm.slice(0, 2000));
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const sig = [];
  for (const [s, arr] of bySym) for (let i = 0; i < 10; i++) sig.push({ sym: s, i });
  const { ledger, fingerprint } = OD.backtest(bySym, sig, { cid: 'M', sl: 0.5, tp: 1, trail: null, mode: 'premium', hold: 5 });
  assert.ok(ledger.length > 0);
  assert.ok(ledger.every(t => t.CONFIG_FINGERPRINT === fingerprint));
  const m = OD.tradeMetrics(ledger);
  assert.equal(m.trade_count, ledger.length);
  assert.equal(m.wins + m.losses + ledger.filter(t => t.ret === 0).length, ledger.length);
});

test('no hardcoded contract assumptions in engine source', () => {
  const src = fs.readFileSync('public/discovery-engine.js', 'utf8');
  for (const pat of ['54700', '54800', '54900', '29SEP', '"CE", "PE"', "['CE', 'PE']", 'if strike ==', 'if symbol ==']) {
    assert.ok(!src.includes(pat), 'hardcode found: ' + pat);
  }
});

test('end-to-end run on 2-day sample file', () => {
  const text = fs.readFileSync('public/sample-banknifty-options.csv', 'utf8');
  const logs = [];
  const res = OD.run(text, { focusStrikes: 3, minEvents: 50, nPerms: 50, seed: 42 }, l => logs.push(l));
  assert.ok(res.candidates.length > 0);
  assert.ok(res.chainMetadata.n_contracts >= 6);
  assert.ok(logs.some(l => l.includes('EXIT_PARAMETER_PROPAGATION = PASS')));
  assert.ok(logs.some(l => l.includes('NO_LOOKAHEAD_TEST = PASS')));
  assert.ok(res.statusBar.PAPER_ELIGIBLE === 'FALSE');
});
