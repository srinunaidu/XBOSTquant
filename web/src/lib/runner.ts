// Grid-search runner: worker-first with main-thread fallback, stop support,
// live progress, hill-climb refinement. Faithful port of the validated logic.
import engine, { type BoardRow, type OHLCV } from './engine';
import { EXIT_LBL } from './config';
import { useStore } from './store';
import { fmtMoney, fmtParams } from './format';

let worker: Worker | null = null;
let rejecter: ((e: any) => void) | null = null;
let seq = 0;

export function buildSelection() {
  const s = useStore.getState();
  const tfs = s.timeframes;
  const sels: any[] = [];
  const paramSteps: Record<string, Record<string, number>> = {};
  for (const [ind, st] of Object.entries(s.inds)) {
    if (!st.on) continue;
    const ranges: Record<string, any> = {};
    const steps: Record<string, number> = {};
    for (const [k, r] of Object.entries(st.ranges)) {
      ranges[k] = { min: +r.min, max: +r.max, step: +r.step };
      steps[k] = +r.step || 0;
    }
    paramSteps[ind] = steps;
    sels.push({ indicator: ind, ranges, steps, timeframes: tfs.length ? tfs : [5] });
  }
  return { sels, paramSteps };
}

export function buildRisk() {
  const s = useStore.getState();
  if (!s.optRisk) return null;
  const sl = engine.expandRange(s.slMin, s.slMax, s.slStep || 0.3);
  const tp = engine.expandRange(s.tpMin, s.tpMax, s.tpStep || 0.5);
  if (!sl.length || !tp.length) return null;
  return { sl, tp };
}

export function buildDims() {
  const s = useStore.getState();
  const carry = s.sessMode === 'carry' ? [true] : s.sessMode === 'both' ? [false, true] : [false];
  return { exits: s.exits.length ? s.exits : ['fixed'], carry };
}

export function estimateCombos(): number {
  try {
    const { sels } = buildSelection();
    return engine.buildGrid(sels, buildRisk(), buildDims()).length;
  } catch { return 0; }
}

export function tradeOpts(): Record<string, any> {
  const s = useStore.getState();
  return {
    direction: s.direction,
    sessionStart: s.useSession ? s.sessStart : null,
    sessionEnd: s.useSession ? s.sessEnd : null,
    slPct: s.slFix, tpPct: s.tpFix, trailPct: s.trail,
    capital: s.capital, qty: s.qty, lotSize: s.lot,
    cost: s.cost,
    beTrigger: s.beTrigger, beLock: s.beLock,
    atrTrailPeriod: s.atrP, atrTrailMult: s.atrM,
    ckPeriod: s.ckP, ckMult: s.ckM,
    fill: s.fill, entry: s.entry,
    regimeOn: s.regimeOn, regimeSource: s.regimeSource,
    granularity: s.granularity, confGate: (s.confGate ?? 60) / 100,
  };
}

function stepsOf(arr: number[]) {
  if (!arr || arr.length < 2) return 0;
  return Math.abs(arr[1] - arr[0]);
}

// Shared routing choke-point (mirrors worker tradeMaskFor): day-first with
// confidence fallback, bar mode for Advanced. Notices fire once per TF.
export function routingFor(cache: Record<number, any>, tf: number, d: any, cfg: any, opts: any) {
  const notes: string[] = [];
  if (!opts.regimeOn) return { mask: null as Int8Array | null, notices: notes };
  const gate = opts.confGate ?? 0.6;
  let c = cache[tf];
  if (!c) c = cache[tf] = {};
  if ((opts.granularity || 'day') === 'day') {
    if (!c.dayRT) {
      c.dayRT = engine.dayRouting(d, { source: opts.regimeSource, confGate: gate });
      c.dayNoted = false;
    }
    const rt = c.dayRT;
    if (!c.dayNoted) {
      c.dayNoted = true;
      rt.notices.forEach((n: string) => notes.push(`${tf}m: ${n}`));
      if (rt.dayReg) {
        let fbD = 0; const total = rt.dayReg.pred.length;
        for (let s = 0; s < total; s++) if (rt.dayReg.pred[s] < 0 || (rt.dayReg.conf && rt.dayReg.conf[s] < gate)) fbD++;
        notes.push(`${tf}m: ${fbD}/${total} fallback days (unrouted, counted)`);
      }
    }
    if (!rt.dayReg) return { mask: null as Int8Array | null, notices: notes };
    return { mask: engine.dayRegimeMask(d, rt.dayReg, cfg.indicator, gate).mask, notices: notes };
  }
  if (!c.reg) c.reg = engine.regimeSeries(d, {});
  if (opts.regimeSource === 'ml' && !c.ml) {
    const r = engine.trainRegimeML(d, 0.7, 15, 200);
    c.ml = { pred: r.pred, acc: r.trainAcc };
    notes.push(`${tf}m: bar-ML train-acc ${(100 * r.trainAcc).toFixed(1)}%`);
  }
  const regs = opts.regimeSource === 'ml' ? c.ml.pred : c.reg;
  return { mask: engine.regimeMask(Array.isArray(regs) ? Int8Array.from(regs) : regs, cfg.indicator), notices: notes };
}

export function logLine(s: string) {
  const st = useStore.getState();
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const log = [...st.log, `[${ts}] ${s}`];
  st.set({ log: log.length > 2000 ? log.slice(log.length - 2000) : log });
}

function fmtETA(sec: number) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function stopRun() {
  const st = useStore.getState();
  if (worker) { try { worker.terminate(); } catch { /* noop */ } worker = null; }
  if (rejecter) { const r = rejecter; rejecter = null; r(new Error('stopped by user')); }
  useStore.getState().set({ stoppedFlag: true });
  seq++;
  useStore.getState().runSeq = seq;
}

function runWithWorker(grid: any[], gData: OHLCV, opts: any, objective: string, topN: number,
  onBatch: (done: number, total: number | string, top: BoardRow[], cur: any, stage: string, pass: number) => void,
  paramSteps: any, risk: any): Promise<{ top: BoardRow[]; refined: number; passes: number; errSamples: any[]; ml?: any[]; route?: string[] }> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try { w = new Worker('/worker.js'); } catch (e) { return reject(e); }
    worker = w;
    const d = gData;
    const timer = window.setTimeout(() => { try { w.terminate(); } catch { /* noop */ } rejecter = null; reject(new Error('worker timeout')); }, 1000 * 60 * 30);
    rejecter = reject;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') onBatch(m.done, m.total, m.top, m.current, m.stage, m.pass);
      else if (m.type === 'done') {
        clearTimeout(timer); w.terminate(); worker = null; rejecter = null;
        resolve({ top: m.top, refined: m.refined || 0, passes: m.passes || 0, errSamples: m.errSamples || [], ml: m.ml || [], route: m.route || [] });
      }
    };
    (w as any).onerror = (e: any) => { clearTimeout(timer); try { w.terminate(); } catch { /* noop */ } worker = null; rejecter = null; reject(e.message || e); };
    w.postMessage({
      type: 'run', t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v,
      grid, tradeOpts: opts, objective, topN, paramSteps: paramSteps || {},
      slStep: risk && risk.sl ? stepsOf(risk.sl) : 0,
      tpStep: risk && risk.tp ? stepsOf(risk.tp) : 0,
    });
  });
}

async function runAsync(grid: any[], opts: any, objective: string, topN: number,
  onBatch: (done: number, total: number | string, top: BoardRow[], cur: any, stage: string, pass: number) => void,
  paramSteps: any, risk: any, mySeq: number, dataSrc?: OHLCV) {
  const data = (dataSrc || useStore.getState().data) as OHLCV;
  let tfCache: any = null, sigCache: any = { key: null, sig: null };
  const res: BoardRow[] = [];
  const getTF = (tf: number) => {
    if (!tfCache || tfCache.tf !== tf) {
      const d = engine.resample(data, tf);
      tfCache = { tf, d, maskIn: engine.buildSessionMask(d, opts.sessionStart, opts.sessionEnd), maskCarry: new Int8Array(d.c.length).fill(1) };
    }
    return tfCache;
  };
  const routeCache: Record<number, any> = {};
  const testCfg = (cfg: any, idx: number, refined: boolean): BoardRow => {
    const tfc = getTF(cfg.timeframe), d = tfc.d;
    const routed = routingFor(routeCache, cfg.timeframe, d, cfg, opts);
    routed.notices.forEach(n => logLine('  route: ' + n));
    const eff: any = Object.assign({}, opts, { sessionMask: cfg.carry ? tfc.maskCarry : tfc.maskIn });
    if (cfg.slPct != null) eff.slPct = cfg.slPct;
    if (cfg.tpPct != null) eff.tpPct = cfg.tpPct;
    if (cfg.trailPct != null) eff.trailPct = cfg.trailPct;
    eff.exit = cfg.exit || 'fixed'; eff.carry = !!cfg.carry;
    const xof = engine.exitOptsFromParams(cfg.indicator, cfg.params || {});
    if (xof) { eff.ckPeriod = xof.ckPeriod; eff.ckMult = xof.ckMult; }
    if (routed.mask) eff.tradeMask = routed.mask;
    const sk = cfg.timeframe + '|' + cfg.indicator + '|' + JSON.stringify(cfg.params);
    if (sigCache.key !== sk) sigCache = { key: sk, sig: engine.buildSignals(d, cfg) };
    const bt = engine.backtest(d, sigCache.sig.pos, eff);
    return {
      i: idx, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params,
      slPct: eff.slPct || 0, tpPct: eff.tpPct || 0, trailPct: eff.trailPct || 0,
      exit: eff.exit, carry: eff.carry, refined: !!refined, m: bt.metrics,
    };
  };
  const partial = () => ({ top: engine.rankResults(res, objective).slice(0, topN), refined: 0, passes: 0, stopped: true });
  for (let i = 0; i < grid.length; i++) {
    if (useStore.getState().runSeq !== mySeq) return partial();
    const cfg = grid[i];
    try { res.push(testCfg(cfg, i, false)); }
    catch (err: any) {
      const s = useStore.getState(); s.set({ run: { ...s.run, errCount: s.run.errCount + 1 } });
      res.push({ i, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params, slPct: cfg.slPct || 0, tpPct: cfg.tpPct || 0, trailPct: 0, exit: cfg.exit || 'fixed', carry: !!cfg.carry, refined: false, m: { netPnL: 0, winRate: 0, totalTrades: 0, profitFactor: 0, maxDD: 0, sharpe: -99, sortino: -99, expectancy: 0, finalCapital: opts.capital || 100000, tradesPerDay: 0, days: 0 } as any, err: String((err as any)?.message || err) });
    }
    if (i % 10 === 0 || i === grid.length - 1) {
      onBatch(i + 1, grid.length, engine.rankResults(res, objective).slice(0, topN),
        { indicator: cfg.indicator, timeframe: cfg.timeframe, params: cfg.params, slPct: cfg.slPct ?? opts.slPct ?? 0, tpPct: cfg.tpPct ?? opts.tpPct ?? 0 }, 'grid', 0);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const tested = new Set(grid.map(c => engine.cfgKey(c)));
  const riskSteps = { sl: risk && risk.sl ? stepsOf(risk.sl) : 0, tp: risk && risk.tp ? stepsOf(risk.tp) : 0 };
  let pool = engine.rankResults(res, objective).slice(0, 20);
  let best = engine.objectiveValue(pool[0].m, objective);
  let pass = 0, refined = 0;
  let improved = true;
  while (improved && pass < 4) {
    if (useStore.getState().runSeq !== mySeq) return { top: engine.rankResults(res, objective).slice(0, topN), refined, passes: pass, stopped: true };
    improved = false; pass++;
    const cands: any[] = [];
    for (const row of pool) {
      for (const nb of engine.paramNeighbors(row, (paramSteps || {})[row.indicator] || {}, riskSteps)) {
        const k = engine.cfgKey(nb);
        if (!tested.has(k)) { tested.add(k); cands.push(nb); }
      }
      if (cands.length > 600) break;
    }
    if (!cands.length) break;
    for (let j = 0; j < cands.length; j++) {
      if (useStore.getState().runSeq !== mySeq) return { top: engine.rankResults(res, objective).slice(0, topN), refined, passes: pass, stopped: true };
      try { res.push(testCfg(cands[j], grid.length + refined, true)); }
      catch { const s = useStore.getState(); s.set({ run: { ...s.run, errCount: s.run.errCount + 1 } }); }
      refined++;
      if (j % 25 === 0 || j === cands.length - 1) {
        onBatch(grid.length + refined, grid.length + '+refine', engine.rankResults(res, objective).slice(0, topN),
          { indicator: cands[j].indicator, timeframe: cands[j].timeframe, params: cands[j].params, slPct: cands[j].slPct || 0, tpPct: cands[j].tpPct || 0 }, 'refine', pass);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    pool = engine.rankResults(res, objective).slice(0, 20);
    const nowBest = engine.objectiveValue(pool[0].m, objective);
    if (nowBest > best + 1e-9) { best = nowBest; improved = true; }
  }
  return { top: engine.rankResults(res, objective).slice(0, topN), refined, passes: pass, stopped: false };
}

// Walk-forward verify: re-run top rows on the untouched OOS tail (same config,
// same regime routing). Rows gain oosNet/oosWR/oosN/survived. Cheap: ≤200 runs.
export async function wfVerify(rows: BoardRow[], opts: any, mySeq: number) {
  const st = useStore.getState();
  const data = st.data!;
  const splitT = data.t[0] + (st.wfSplit / 100) * (data.t[data.t.length - 1] - data.t[0]);
  let si = 0;
  while (si < data.t.length && data.t[si] < splitT) si++;
  const pick = (a: Float64Array) => a.slice(si);
  const oos = { t: pick(data.t), o: pick(data.o), h: pick(data.h), l: pick(data.l), c: pick(data.c), v: pick(data.v) };
  if (oos.t.length < 50) return 'OOS slice too thin, skipped';
  const tfCache: Record<number, any> = {};
  const wfRouteCache: Record<number, any> = {};
  const getTF = (tf: number) => {
    if (!tfCache[tf]) {
      const d = engine.resample(oos as any, tf);
      tfCache[tf] = { d, maskIn: engine.buildSessionMask(d, opts.sessionStart, opts.sessionEnd), maskCarry: new Int8Array(d.c.length).fill(1), reg: null as any, ml: null as any };
    }
    return tfCache[tf];
  };
  const cands = rows.slice(0, 200);
  for (let k = 0; k < cands.length; k++) {
    if (useStore.getState().runSeq !== mySeq) return 'aborted';
    const r = cands[k];
    const tfc = getTF(r.timeframe);
    const eff: any = Object.assign({}, opts, {
      sessionMask: r.carry ? tfc.maskCarry : tfc.maskIn,
      slPct: r.slPct, tpPct: r.tpPct, trailPct: r.trailPct ?? opts.trailPct,
      exit: r.exit || 'fixed', carry: !!r.carry,
    });
    const xo = engine.exitOptsFromParams(r.indicator, r.params || {});
    if (xo) { eff.ckPeriod = xo.ckPeriod; eff.ckMult = xo.ckMult; }
    { const routed = routingFor(wfRouteCache, r.timeframe, tfc.d, r, eff);
      if (routed.mask) eff.tradeMask = routed.mask;
      routed.notices.forEach(n => logLine('  WF route: ' + n)); }
    const sig = engine.buildSignals(tfc.d, { indicator: r.indicator, params: r.params });
    const bt = engine.backtest(tfc.d, sig.pos, eff);
    r.oosNet = bt.metrics.netPnL; r.oosWR = bt.metrics.winRate; r.oosN = bt.metrics.totalTrades;
    r.survived = bt.metrics.netPnL > 0;
    if (k % 25 === 0) await new Promise(rr => setTimeout(rr, 0));
  }
  const surv = cands.filter(r => r.survived).length;
  return `WF ${st.wfSplit}/${100 - st.wfSplit}: ${surv}/${cands.length} survived OOS`;
}

export async function runGrid() {
  const st = useStore.getState();
  if (!st.data) { st.set({ alert: 'No market data — upload a 1-min CSV before running a search.' }); return; }
  const { sels, paramSteps } = buildSelection();
  if (!sels.length) { st.set({ alert: 'No indicators selected — enable at least one strategy.' }); return; }
  const risk = buildRisk();
  const dims = buildDims();
  let grid = engine.buildGrid(sels, risk, dims);
  grid.forEach((c: any) => { c._sk = c.timeframe + '|' + c.indicator + '|' + JSON.stringify(c.params); });
  grid.sort((a: any, b: any) => (a._sk < b._sk ? -1 : 1));
  if (grid.length > st.cap) {
    const ok = window.confirm(`Grid = ${grid.length} combos > cap ${st.cap}. Truncate to first ${st.cap}?`);
    if (!ok) return;
    grid = grid.slice(0, st.cap);
  }
  if (!grid.length) { st.set({ alert: 'Empty grid — check parameter ranges.' }); return; }
  const objective = st.objective, topN = st.topN;
  const opts = tradeOpts();
  // Walk-forward: grid searches the in-sample slice; top rows verify on the
  // untouched out-of-sample tail. Detail/compare views stay full-data.
  let gData = st.data!;
  let wfNote = '';
  if (st.wfOn && st.data!.t.length > 200) {
    const d0 = st.data!.t[0], d1 = st.data!.t[st.data!.t.length - 1];
    const cut = d0 + (st.wfSplit / 100) * (d1 - d0);
    let si = 0;
    while (si < st.data!.t.length && st.data!.t[si] < cut) si++;
    const pk = (a: Float64Array) => a.slice(0, si);
    gData = { t: pk(st.data!.t), o: pk(st.data!.o), h: pk(st.data!.h), l: pk(st.data!.l), c: pk(st.data!.c), v: pk(st.data!.v) };
    wfNote = ` WF ${st.wfSplit}/${100 - st.wfSplit}`;
  }
  const mySeq = seq + 1; seq = mySeq;
  st.runSeq = mySeq;
  st.set({ alert: null });
  const t0 = performance.now();
  let lastRender = 0;
  const setRun = (p: Partial<typeof st.run>) => useStore.getState().set({ run: { ...useStore.getState().run, ...p } });
  setRun({ running: true, done: 0, total: grid.length, stage: 'grid', pass: 0, perSec: 0, eta: '', current: 'warming up…', errCount: 0, refined: 0, passes: 0, summary: `0 / ${grid.length}` });
  logLine(`run start: ${st.symbol || '?'} ${(st.data.t.length / 1000).toFixed(0)}k bars objective=${objective} dir=${opts.direction}/${opts.entry}/${opts.fill} exits=[${dims.exits.join(',')}] sess=${dims.carry.length > 1 ? 'day+carry' : dims.carry[0] ? 'carry' : 'day'} regime=${opts.regimeOn ? opts.regimeSource + '/' + (opts.granularity || 'day') : 'off'}${wfNote} cap=${opts.capital} qty=${opts.qty}x${opts.lotSize} cost=${opts.cost} grid=${grid.length}`);
  const onBatch = (done: number, total: number | string, top: BoardRow[], current: any, stage: string, pass: number) => {
    if (useStore.getState().runSeq !== mySeq) return;
    if (stage === 'refine' && !useStore.getState()._refineAt) useStore.getState()._refineAt = performance.now();
    const pct = typeof done === 'number' && typeof total === 'number' ? ((done / total) * 100).toFixed(1) : '—';
    const el = (performance.now() - t0) / 1000;
    const perSec = (typeof done === 'number' ? done : 0) / Math.max(0.5, el);
    let eta = '';
    if (stage !== 'refine' && typeof done === 'number' && typeof total === 'number' && done > 5 && perSec > 0) {
      const s = Math.round((total - done) / perSec);
      eta = ` · ETA ${fmtETA(s)}`;
    }
    const cur = current ? `${stage === 'refine' ? '🔁 refining best:' : '⚙ now running:'} ${current.indicator} ${current.timeframe}m · ${fmtParams(current.params)}${current.slPct != null ? ` · SL ${current.slPct}% TP ${current.tpPct}%` : ''}${current.exit ? ` · ${EXIT_LBL[current.exit] || current.exit}${current.carry ? '+carry' : ''}` : ''}` : '';
    setRun({ done: typeof done === 'number' ? done : 0, total, perSec, eta, current: cur, summary: `${done} / ${total}${stage === 'refine' ? ` · refine pass ${pass || ''}` : ''} (${pct}%) · ${perSec.toFixed(0)}/s${eta}` });
    useStore.getState().set({ board: top });
    const now = performance.now();
    if (now - lastRender > 700 || done === total) { lastRender = now; useStore.getState().set({ boardTick: useStore.getState().boardTick + 1 }); }
    const s2 = useStore.getState();
    if (top.length && !s2.detail) selectRow(top[0], true);
  };
  let top: BoardRow[] = [], refineInfo = '', errSamples: any[] = [], runMode = 'worker', stopped = false;
  let mlInfo: any[] = [], routeInfo: string[] = [];
  useStore.getState()._refineAt = null;
  try {
    const out = await runWithWorker(grid, gData, opts, objective, topN, onBatch, paramSteps, risk);
    top = out.top;
    refineInfo = out.refined ? ` · 🔁 +${out.refined} refined (${out.passes} passes)` : '';
    errSamples = out.errSamples || [];
    mlInfo = out.ml || [];
    routeInfo = (out as any).route || [];
    if (useStore.getState().runSeq === mySeq) useStore.getState().set({ board: top });
  } catch (err: any) {
    if (useStore.getState().stoppedFlag) { /* fall through to stopped finalizer */ }
    else {
      logLine(`worker unavailable (${err?.message || err}) — main-thread fallback`);
      runMode = 'fallback';
      try {
        const out = await runAsync(grid, opts, objective, topN, onBatch, paramSteps, risk, mySeq, gData);
        top = out.top;
        refineInfo = out.refined ? ` · 🔁 +${out.refined} refined (${out.passes} passes)` : '';
        stopped = !!out.stopped;
        useStore.getState().set({ board: top });
      } catch (err2: any) {
        setRun({ running: false, summary: `❌ ERROR: ${err2?.message || err2}` });
        useStore.getState().set({ alert: `Grid search failed: ${err2?.message || err2} — see console (F12).` });
        logLine(`run ERROR: ${err2?.message || err2}`);
        return;
      }
    }
  }
  const s3 = useStore.getState();
  if (s3.stoppedFlag) stopped = true;
  s3.stoppedFlag = false;
  worker = null;
  if (s3.runSeq !== mySeq && !stopped) return;
  const secs = (performance.now() - t0) / 1000;
  const gridSecs = s3._refineAt ? (s3._refineAt - t0) / 1000 : secs;
  if (stopped) {
    const b = useStore.getState().board;
    setRun({ running: false, summary: `■ stopped by user — partial board kept (${b.length} rows)` });
    logLine(`run STOPPED by user after ${secs.toFixed(1)}s — partial board kept`);
    useStore.getState().set({ alert: `Search stopped — showing partial results (${b.length} rows).` });
  } else {
    const errs = useStore.getState().run.errCount;
    routeInfo.forEach((n: string) => logLine(`  route: ${n}`));
    mlInfo.forEach((m: any) => logLine(`  ML regime ${m.tf}m: train-acc ${(m.trainAcc * 100).toFixed(1)}% in ${m.ms}ms`));
    let wfMsg = '';
    if (st.wfOn && !stopped) {
      setRun({ summary: `done · verifying top-200 out-of-sample…` });
      wfMsg = await wfVerify(useStore.getState().board, opts, mySeq);
      logLine(wfMsg);
      useStore.getState().set({ board: useStore.getState().board });
    }
    setRun({ running: false, refined: 0, passes: 0, summary: `done · ${grid.length} combos in ${secs.toFixed(1)}s${refineInfo}${errs ? ` · ⚠ ${errs} errored` : ''}${wfMsg ? ` · ${wfMsg}` : ''}` });
    logLine(`run done (${runMode}): ${grid.length} combos in ${secs.toFixed(1)}s [grid ${gridSecs.toFixed(1)}s${s3._refineAt ? ` + refine ${(secs - gridSecs).toFixed(1)}s` : ''}] ${(grid.length / Math.max(secs, 0.01)).toFixed(0)}/s objective=${objective} errors=${errs}${refineInfo}${wfMsg ? ' · ' + wfMsg : ''}`);
    errSamples.forEach((e: any) => logLine(`  combo error: ${e}`));
  }
  const bd = useStore.getState().board;
  bd.slice(0, 3).forEach((r, i) => logLine(`  #${i + 1} ${r.timeframe}m ${r.indicator} ${fmtParams(r.params)} SL=${r.slPct} TP=${r.tpPct} WR=${r.m.winRate.toFixed(1)}% n=${r.m.totalTrades} pnl=${r.m.netPnL.toFixed(0)}`));
  setRun({ current: '' });
  const s4 = useStore.getState();
  if (bd.length && !s4.userPickedSeq) selectRow(bd[0], true);
}

export function selectRow(r: BoardRow, auto?: boolean) {
  const st = useStore.getState();
  if (!auto) st.userPickedSeq = st.runSeq || 0;
  const data = st.data as OHLCV;
  const d = engine.resample(data, r.timeframe);
  const sig = engine.buildSignals(d, { indicator: r.indicator, params: r.params });
  const eff: any = tradeOpts();
  if (r.slPct != null) eff.slPct = r.slPct;
  if (r.tpPct != null) eff.tpPct = r.tpPct;
  if (r.trailPct != null) eff.trailPct = r.trailPct;
  eff.exit = r.exit || 'fixed'; eff.carry = !!r.carry;
  const xod = engine.exitOptsFromParams(r.indicator, r.params || {});
  if (xod) { eff.ckPeriod = xod.ckPeriod; eff.ckMult = xod.ckMult; }
  { const routed = routingFor({}, r.timeframe, d, r, eff);
    if (routed.mask) eff.tradeMask = routed.mask; }
  eff.sessionMask = eff.carry ? new Int8Array(d.c.length).fill(1) : engine.buildSessionMask(d, eff.sessionStart, eff.sessionEnd);
  const bt = engine.backtest(d, sig.pos, eff);
  useStore.getState().set({ sel: r, detail: { cfg: r, data: d, sig, bt } });
}

