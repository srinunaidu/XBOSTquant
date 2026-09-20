// Live-data validation (L1–L7) + session log. Port of the validated routine.
import engine from './engine';
import { useStore } from './store';
import { logLine, tradeOpts } from './runner';

export function runValidation() {
  const st = useStore.getState();
  const out: string[] = [];
  let pass = 0, fail = 0, skip = 0;
  const ok = (name: string, cond: boolean, extra?: string) => {
    if (cond) { pass++; out.push('PASS ' + name); }
    else { fail++; out.push('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
  };
  logLine('validation started');
  try {
    if (!st.data || !st.data.t.length) {
      out.push('Load live data first (upload CSV or bundled file).');
      st.set({ validation: out, valOk: false });
      return;
    }
    const d = st.data, n = d.t.length;
    out.push(`live data: ${st.symbol} · ${n.toLocaleString()} 1m bars · ${new Date(d.t[0]).toLocaleDateString()} → ${new Date(d.t[n - 1]).toLocaleDateString()}`);
    let asc = true, dup = false, nanPx = false;
    const seen = new Set<number>();
    const step = Math.max(1, Math.floor(n / 200000));
    for (let i = 1; i < n; i += step) if (d.t[i] <= d.t[i - 1]) asc = false;
    for (let i = 0; i < n; i += step) {
      const k = d.t[i];
      if (seen.has(k)) dup = true;
      seen.add(k);
      if (!isFinite(d.o[i] + d.h[i] + d.l[i] + d.c[i])) nanPx = true;
    }
    ok('L1 timestamps ascending, no dups, prices finite', asc && !dup && !nanPx, `asc=${asc} dup=${dup} nan=${nanPx}`);
    const d5 = engine.resample(d, 5);
    let v1 = 0; for (let i = 0; i < n; i++) v1 += d.v[i];
    let v5 = 0; for (let i = 0; i < d5.t.length; i++) v5 += d5.v[i];
    ok('L2 resample conserves volume', Math.abs(v1 - v5) < 1e-6, `1m=${v1} 5m=${v5}`);
    ok('L2 resample bar count sane', d5.t.length > 0 && d5.t.length <= n, `${d5.t.length} bars`);
    const sig = engine.buildSignals(d5, { indicator: 'EMA', params: { period: 21 } });
    let firstSig = -1;
    for (let i = 0; i < sig.pos.length; i++) if (sig.pos[i] !== 0) { firstSig = i; break; }
    ok('L3 warmup quarantined (first signal >= bar 20)', firstSig >= 20, 'first=' + firstSig);
    const eff = tradeOpts();
    eff.sessionMask = engine.combineMasks(engine.buildSessionMask(d5, eff.sessionStart, eff.sessionEnd), engine.buildWindowMask(d5.t, eff.tradeWindows));
    const bt = engine.backtest(d5, sig.pos, eff);
    const m = bt.metrics;
    ok('L4 cost identity (net == grossP - grossL)', Math.abs(m.netPnL - (m.grossProfit - m.grossLoss)) < 0.01, `${(m.grossProfit - m.grossLoss).toFixed(2)} vs ${m.netPnL.toFixed(2)}`);
    let s = 0; for (const t of bt.trades) s += t.pnl;
    ok('L4 equity identity (final == cap + sum pnl)', Math.abs(m.finalCapital - (eff.capital + s)) < 0.01);
    let handOk = bt.trades.length > 0, handMsg = '';
    for (let k = 0; k < Math.min(3, bt.trades.length); k++) {
      const t = bt.trades[k];
      const pxIn = t.entryPx === d5.o[t.entryIdx] || t.entryPx === d5.c[t.entryIdx];
      const ux = (t.type === 'LONG' ? t.exitPx - t.entryPx : t.entryPx - t.exitPx) * (eff.qty * eff.lotSize) - eff.cost;
      if (!(pxIn && Math.abs(ux - t.pnl) < 0.01)) { handOk = false; handMsg = 'trade#' + t.id; }
    }
    ok('L4 first 3 trades reprice from bars', handOk, handMsg || `${bt.trades.length} trades`);
    if (eff.fill === 'next') {
      const bad = bt.trades.filter(t => Math.abs(t.entryPx - d5.o[t.entryIdx]) > 1e-9);
      ok('L4 next-open fills at open[]', bad.length === 0, bad.length + ' bad');
    } else out.push('SKIP L4-next-open (fill mode = close; switch ⑥ to test)');
    const d1m = st.data;
    const m1 = engine.buildSessionMask(d1m, eff.sessionStart, eff.sessionEnd);
    const s1 = engine.buildSignals(d1m, { indicator: 'EMA', params: { period: 21 } });
    const be = engine.backtest(d1m, s1.pos, Object.assign({}, eff, { exit: 'breakeven', sessionMask: m1 }));
    const at = engine.backtest(d1m, s1.pos, Object.assign({}, eff, { exit: 'atr', sessionMask: m1 }));
    const hasBE = be.trades.some(t => t.reason === 'BE'), hasATR = at.trades.some(t => t.reason === 'ATR');
    if (be.trades.length + at.trades.length < 10) {
      out.push(`SKIP L5 legs need ≥10 trades, file gave ${be.trades.length + at.trades.length} — upload more sessions for a conclusive check`); skip++;
    } else ok('L5 breakeven + chandelier legs fire live', hasBE && hasATR, `BE=${hasBE} ATR=${hasATR}`);
    let runEq = eff.capital, ruinAt = -1;
    for (const t of bt.trades) { runEq += t.pnl; if (runEq <= 0 && ruinAt < 0) ruinAt = t.exitIdx; }
    const postRuin = ruinAt >= 0 ? bt.trades.filter(t => t.entryIdx > ruinAt).length : 0;
    let maxLoss = 0; for (const t of bt.trades) if (-t.pnl > maxLoss) maxLoss = -t.pnl;
    ok('L6 no entries after ruin', postRuin === 0, postRuin + ' post-ruin entries');
    ok('L6 overshoot ≤ one trade', m.finalCapital >= -(maxLoss + 1e-6), `final=${m.finalCapital.toFixed(0)} max1loss=${maxLoss.toFixed(0)}`);
    ok('L6 metrics finite, DD ≤ 0', isFinite(m.sharpe) && isFinite(m.sortino) && isFinite(m.maxDD) && m.maxDD <= 0,
      `sharpe=${m.sharpe.toFixed(2)} sortino=${m.sortino.toFixed(2)} dd=${m.maxDD.toFixed(2)}`);
    let inn = 0; for (let i = 0; i < eff.sessionMask.length; i++) inn += eff.sessionMask[i];
    out.push(`L7 session coverage ${(inn / eff.sessionMask.length * 100).toFixed(1)}% · OHLCV-only engine · fill=${eff.fill} · exit=${eff.exit || 'fixed'}${eff.carry ? ' +carry' : ''} · regime=${eff.regimeOn ? eff.regimeSource + '/' + (eff.granularity || 'day') : 'off'}`);
    // Layer checks: regimes / ML / walk-forward viability — FAILS are loud
    const layers = engine.validateLayers(d, {
      ml: eff.regimeSource === 'ml', confGate: eff.confGate ?? 0.6,
      wf: st.wfOn, wfSplit: st.wfSplit,
      exits: { sig, bt },
    });
    for (const c of layers) {
      const tag = c.pass ? (c.warn ? 'WARN' : 'PASS') : 'FAIL';
      out.push(`${tag} ${c.name} :: ${c.detail}`);
      if (c.pass) { if (c.warn) skip++; else pass++; }
      else fail++;
    }
    out.push('');
    out.push(`LIVE VALIDATION: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped (thin file)` : ''} — ${st.symbol}, real data only.`);
    logLine(`validation: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  } catch (err: any) {
    out.push('VALIDATION FATAL: ' + (err?.message || err)); fail++;
    logLine('validation FATAL: ' + (err?.message || err));
  }
  out.forEach(l => logLine('[val] ' + l));
  useStore.getState().set({ validation: out, valOk: fail === 0 });
  if (fail > 0) {
    useStore.getState().set({ alert: `Validation FAILED on ${fail} check(s) — see 🛠 panel. Nothing was assumed; fix the flagged layer before trusting results.` });
  }
}
