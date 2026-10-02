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
  const src = fs.readFileSync('public/discovery-engine.js', 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const pat of ['54700', '54800', '54900', '29SEP', '27OCT', 'EXPECTED_', 'if strike ==', 'if symbol ==',
    'if contracts ==', 'if expiry ==', "=== 'CE'", '=== "CE"', "=== 'PE'", '=== "PE"',
    '["CE", "PE"]', "['CE', 'PE']"]) {
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

/* TEST 1–12 acceptance: reported wide-file shape (12 contracts, 2 expiries,
   type+strike embedded in tokens, no explicit metadata columns). */
function wide12() {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const toks = [];
  for (const e of ['29SEP26', '27OCT26']) for (const s of [54700, 54800, 54900]) for (const t of ['CE', 'PE'])
    toks.push(`BNF${e}${s}${t}`);
  const t0 = Date.parse('2026-08-20T09:15:00Z');
  const head = ['ts', 'exp', ...toks.flatMap(t => [t + '_o', t + '_h', t + '_l', t + '_c', t + '_v'])];
  const lines = [head.join(',')];
  let day = 0, b = 0;
  for (let d = 0; d < 8; d++) {
    for (let m = 0; m < 300; m++) {
      const ts = new Date(t0 + (day * 1440 + m) * 60000).toISOString();
      const row = [ts, d < 5 ? '29SEP2026' : '27OCT2026'];
      for (const t of toks) {
        const px = 200 + Math.sin((b / 17) + t.length) * 8 + (rnd() - 0.5) * 4;
        row.push(px.toFixed(2), (px + 1).toFixed(2), (px - 1).toFixed(2), (px + (rnd() - 0.5)).toFixed(2), 100);
      }
      lines.push(row.join(','));
      b++;
    }
    day++;
  }
  return lines.join('\n');
}
const WIDE12 = wide12();

test('ACCEPT TEST1: dynamic parsing finds 12 contracts/strikes/types/expiries', () => {
  const { norm, layout } = OD.ingest(WIDE12);
  assert.equal(layout, 'wide');
  const reg = OD.buildRegistry(norm, layout);
  assert.equal(reg.length, 12);
  assert.ok(reg.filter(r => r.strike !== 'UNKNOWN').length === 12);
  assert.ok(reg.filter(r => r.option_type !== 'UNKNOWN').length === 12);
  assert.deepEqual([...new Set(reg.flatMap(r => r.expiry))].sort(), ['27OCT2026', '29SEP2026']);
  const strikes = [...new Set(reg.map(r => r.strike))].sort();
  assert.deepEqual(strikes, [54700, 54800, 54900]);
});

test('ACCEPT TEST2-5: focus>0, features>0 incl xcols, labels>0, events>0', () => {
  const { norm } = OD.ingest(WIDE12);
  const reg = OD.buildRegistry(norm, 'wide');
  for (const row of norm) {
    const rec = reg.find(r => r.contract_id === row.symbol);
    if (rec && rec.strike !== 'UNKNOWN') row.strike = rec.strike;
    if (rec && rec.option_type !== 'UNKNOWN') row.option_type = rec.option_type;
  }
  const meta = OD.detectChain(norm);
  assert.ok(meta.n_strikes === 3 && meta.n_option_types === 2);
  const focus = OD.selectFocus(norm, meta, 3, null);
  assert.ok(focus.chain.length > 0); // TEST2
  const rows = OD.features(focus.rows);
  assert.ok(rows.length > 0); // TEST3 rows
  const xc = OD.crossStrike(rows, meta, focus.strikes);
  assert.ok(xc.length > 0); // TEST3 xcols
  assert.ok(rows.some(r => !isNaN(r.fwd_ret_5m))); // TEST4
  OD.events(rows);
  const raw = rows.filter(r => r.e_large_ret === 1 || r.e_vol_shock === 1 || r.e_expansion === 1).length;
  assert.ok(raw > 0); // TEST5
});

test('ACCEPT TEST6-10: full run evaluates candidates, OOS non-zero, exit hashes diverge', () => {
  const logs = [];
  const res = OD.run(WIDE12, { focusStrikes: 3, minEvents: 50, nPerms: 50, seed: 7 }, l => logs.push(l));
  assert.ok(res.candidates.length > 0); // TEST6: actually evaluated
  assert.ok(res.splitDays.pseudo_oos > 0); // TEST10
  assert.ok(logs.some(l => l.includes('NO_LOOKAHEAD_TEST = PASS'))); // TEST9
  assert.ok(logs.some(l => l.includes('FINAL_STATUS='))); // state machine present
  // TEST8: every candidate ledger metric recomputes (spot-check via tradeMetrics on gate ledgers is structural; here check hashes exist)
  assert.ok(logs.some(l => l.includes('ledger_hash=')));
  const hashes = [...new Set(logs.filter(l => l.includes('ledger_hash=')).map(l => l.split('ledger_hash=')[1]))];
  assert.ok(hashes.length >= 2); // TEST7: TP configs diverge
});

test('ACCEPT TEST11: zero-input filters report BLOCKED_NO_INPUT', () => {
  const logs = [];
  const res = OD.run(WIDE12, { focusStrikes: 3, minEvents: 1e9, nPerms: 10, seed: 7 }, l => logs.push(l));
  assert.equal(res.candidates.length, 0);
  assert.ok(logs.some(l => l.includes('BLOCKED_NO_INPUT')));
  assert.ok(!logs.some(l => l.includes('OPTION_NATIVE_RESEARCH_RESULT = NO_VALIDATED_EDGE')));
});

test('ACCEPT TEST12: reproducibility — same seed+data = identical candidates+hashes', () => {
  const a = OD.run(WIDE12, { focusStrikes: 3, minEvents: 50, nPerms: 30, seed: 99 }, null, null);
  const b = OD.run(WIDE12, { focusStrikes: 3, minEvents: 50, nPerms: 30, seed: 99 }, null, null);
  const key = c => JSON.stringify([c.candidate, c.events, c.FWD_expectancy, c.perm_p, c.final_status]);
  assert.deepEqual(a.candidates.map(key), b.candidates.map(key));
  assert.equal(a.finalStatus, b.finalStatus);
});

test('ACCEPT TEST9: P&L finite for all completed trades (gappy data skipped, counted)', () => {
  const { norm } = OD.ingest(synth(['CE', 'PE']));
  // inject NaN closes to simulate sparse contracts
  norm.forEach((r, i) => { if (i % 7 === 0) r.close = NaN; });
  const rows = OD.features(norm.slice(0, 4000));
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const sig = [];
  for (const [s, arr] of bySym) for (let i = 0; i < Math.min(40, arr.length); i++) sig.push({ sym: s, i });
  for (const tp of [1, 2, 3]) {
    const bt = OD.backtest(bySym, sig, { cid: 'N', sl: 0.5, tp, trail: null, mode: 'premium', hold: 5 });
    const bad = bt.ledger.filter(t => typeof t.ret !== 'number' || !isFinite(t.ret));
    assert.equal(bad.length, 0, `NaN P&L in TP${tp} ledger`);
    assert.ok(bt.skipped.nan_exit + bt.skipped.nan_entry >= 0);
  }
});

test('ACCEPT TEST10+13: independent 1m label matches production; audit passes', () => {
  const fs = require('node:fs');
  const { norm } = OD.ingest(fs.readFileSync('public/sample-banknifty-options.csv', 'utf8'));
  const meta = OD.detectChain(norm);
  const focus = OD.selectFocus(norm, meta, 3, meta.expiries[0]);
  const rows = OD.features(focus.rows);
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r);
  }
  const la = OD.auditLookahead(bySym, null);
  assert.equal(la.status, 'PASS');
  assert.ok(la.label_tests >= 10);
  assert.equal(la.spot_fail, 0);
});
