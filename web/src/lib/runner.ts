// Grid-search runner: worker-first with main-thread fallback, stop support,
// live progress, hill-climb refinement. Faithful port of the validated logic.
import engine, { type BoardRow, type OHLCV } from './engine';
import { EXIT_LBL, IND_META, WIN_MAP } from './config';
import { useStore } from './store';
import { fmtMoney, fmtParams } from './format';
import { enabledSymbols, filterData, dataHealth } from './data';
import Robust from './robustness';
import { candidateId, formatCandidateHeader, formatCoreSignal, formatIsOos } from './report';

const IND_TIER: Record<string, string> = {};
for (const m of IND_META) if (m.n && m.tier) IND_TIER[m.n] = m.tier;

function selsForTiers(tiers: string[]) {
  const s = useStore.getState();
  const tfs = s.timeframes;
  const sels: any[] = [];
  const paramSteps: Record<string, Record<string, number>> = {};
  const want = new Set(tiers);
  for (const [ind, st] of Object.entries(s.inds)) {
    if (!want.has(IND_TIER[ind] || 'B')) continue;
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

function isGood(m: any): boolean {
  if (!m || m.totalTrades < 5) return false;
  // Balanced gate across your 5 objectives: WR, T/day proxy via trades, DD, Sharpe/Sortino
  // Tuned to be permissive — only fails when edge is clearly weak.
  const ddOk = m.maxDD >= -15; // not catastrophic
  const wrOk = m.winRate >= 52;
  const pfOk = m.profitFactor >= 1.15;
  const shOk = m.sharpe >= 1.0;
  // Good if Sharpe passes + at least 2 of the other 3
  let score = 0;
  if (wrOk) score++; if (pfOk) score++; if (ddOk) score++;
  return shOk && score >= 2;
}

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
    const st = useStore.getState();
    const { sels } = buildSelection();
    if (st.gridMode === 'halton') return engine.buildHaltonGrid(sels, buildRisk(), buildDims(), st.haltonN).length;
    return engine.buildGrid(sels, buildRisk(), buildDims()).length;
  } catch { return 0; }
}

export function tradeOpts(): Record<string, any> {
  const s = useStore.getState();
  let direction = s.direction;
  if (s.instrumentMode === 'options' && direction !== 'Long') {
    // Buy-only enforcement: options desk can never short premium.
    direction = 'Long';
    logLine('options desk: buy-only enforced (direction forced Long — no short premium)');
  }
  // Exchange-aware sessions: explicit exchange wins, else auto-detect from
  // the active symbol (MCX commodities trade 09:00–23:30, not NSE hours).
  const ex = s.exchange && s.exchange !== 'auto' ? s.exchange : engine.detectExchange(s.symbol);
  const sess = engine.resolveSession(ex, s.useSession ? s.sessStart : null, s.useSession ? s.sessEnd : null);
  let cost = s.cost;
  if (s.costMode === 'signal') {
    if (cost > 0) logLine('cost mode: SIGNAL-ONLY — costs zeroed for research (paper gate will warn, not pass)');
    cost = 0;
  }
  return {
    direction,
    exchange: sess.exchange,
    sessionStart: sess.start, sessionEnd: sess.end,
    slPct: s.slFix, tpPct: s.tpFix, trailPct: s.trail,
    capital: s.capital, qty: s.qty, lotSize: s.lot,
    cost, costMode: s.costMode,
    premiumFloor: s.premiumFloor || 0, excludeExpiry: !!s.excludeExpiry,
    ivMaxRank: s.ivMaxRank,
    beTrigger: s.beTrigger, beLock: s.beLock,
    atrTrailPeriod: s.atrP, atrTrailMult: s.atrM,
    atrTpMult: s.atrTpMult, maxHoldBars: s.maxHoldBars,
    ckPeriod: s.ckP, ckMult: s.ckM,
    fill: s.fill, entry: s.entry,
    regimeOn: s.regimeOn, regimeSource: s.regimeSource,
    granularity: s.granularity, confGate: (s.confGate ?? 60) / 100,
    routerV2: s.routerV2, routerPersist: s.routerPersist, routerHyst: s.routerHyst,
    purgeBars: s.purgeBars, embargoBars: s.embargoBars,
    sigSource: s.sigSource || 'prices',
    tradeWindows: sess.exchange !== 'NSE' ? [] : s.tradeWindows.map((w: string) => WIN_MAP[w]).filter(Boolean),
  };
}

// Underlying dataset for underlying-led signals: first enabled non-options
// dataset different from `except`. Null = no underlying available.
export function underlyingFor(except?: string): [string, OHLCV] | null {
  const st = useStore.getState();
  const isOpt = (k: string) => {
    const kk = (k || '').toUpperCase().replace(/[^A-Z]/g, '');
    return /(CE|PE)$/.test(kk) || kk.includes('OPTION');
  };
  for (const k of Object.keys(st.datasets)) {
    if (k === except) continue;
    const ds = st.datasets[k];
    if (!isOpt(k) && ds.enabled !== false && ds.raw.t.length > 100) return [k, filterData(ds.raw, st.fromDate, st.toDate)];
  }
  return null;
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
    let dayReg = rt.dayReg;
    if (opts.routerV2) {
      // Router v2: persistence + hysteresis on day labels before masking.
      const vk = 'v2_' + (opts.routerPersist ?? 5) + '_' + (opts.routerHyst ?? 2);
      if (!c.daySm || c.daySm.k !== vk) {
        c.daySm = { k: vk, pred: Array.from(engine.smoothRegime(Int8Array.from(dayReg.pred), opts.routerPersist ?? 5, opts.routerHyst ?? 2)) };
      }
      dayReg = { ...dayReg, pred: c.daySm.pred };
      if (!c.v2Noted) { c.v2Noted = true; notes.push(`${tf}m: router-v2 persistence ${opts.routerPersist ?? 5}+${opts.routerHyst ?? 2} smoothing ${dayReg.pred.length} day labels`); }
    }
    return { mask: engine.dayRegimeMask(d, dayReg, cfg.indicator, gate).mask, notices: notes };
  }
  if (!c.reg) c.reg = engine.regimeSeries(d, {});
  if (opts.regimeSource === 'ml' && !c.ml) {
    const r = engine.trainRegimeML(d, 0.7, 15, 200);
    c.ml = { pred: r.pred, acc: r.trainAcc };
    notes.push(`${tf}m: bar-ML train-acc ${(100 * r.trainAcc).toFixed(1)}%`);
  }
  const regs = opts.regimeSource === 'ml' ? c.ml.pred : c.reg;
  let regArr = Array.isArray(regs) ? Int8Array.from(regs) : regs;
  if (opts.routerV2) {
    const vk = 'v2_' + (opts.routerPersist ?? 5) + '_' + (opts.routerHyst ?? 2);
    if (!c.regSm || c.regSm.k !== vk) {
      c.regSm = { k: vk, arr: engine.smoothRegime(regArr, opts.routerPersist ?? 5, opts.routerHyst ?? 2) };
    }
    regArr = c.regSm.arr;
  }
  return { mask: engine.regimeMask(regArr, cfg.indicator), notices: notes };
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
  useStore.getState().set({ runSeq: seq });
}

function runWithWorker(grid: any[], gData: OHLCV, sym: string, opts: any, objective: string, topN: number,
  onBatch: (done: number, total: number | string, top: BoardRow[], cur: any, stage: string, pass: number) => void,
  paramSteps: any, risk: any, undData?: OHLCV | null): Promise<{ top: BoardRow[]; refined: number; passes: number; errSamples: any[]; ml?: any[]; route?: string[]; robustnessLogs?: string[] }> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try { w = new Worker('/worker.js'); } catch (e) { return reject(e); }
    worker = w;
    const d = gData;
    const timer = window.setTimeout(() => { try { w.terminate(); } catch { /* noop */ } rejecter = null; reject(new Error('worker timeout')); }, 1000 * 60 * 30);
    rejecter = reject;
    // Heartbeat watchdog: a healthy worker posts progress every batch (25
    // combos). 90s of silence = wedged worker → fail loud into fallback
    // instead of hanging on "warming up" forever.
    let heartBeat = window.setTimeout(() => { }, 0);
    const pulse = () => {
      clearTimeout(heartBeat);
      heartBeat = window.setTimeout(() => {
        clearTimeout(timer);
        try { w.terminate(); } catch { /* noop */ }
        worker = null; rejecter = null;
        reject(new Error('worker heartbeat lost (no progress for 90s) — failing over to main-thread run'));
      }, 90000);
    };
    const settle = () => { clearTimeout(timer); clearTimeout(heartBeat); };
    pulse();
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'progress') { pulse(); onBatch(m.done, m.total, m.top, m.current, m.stage, m.pass); }
      else if (m.type === 'error') {
        settle(); try { w.terminate(); } catch { /* noop */ } worker = null; rejecter = null;
        reject(new Error('worker: ' + (m.message || 'unknown error')));
      }
      else if (m.type === 'done') {
        settle(); w.terminate(); worker = null; rejecter = null;
        resolve({ top: m.top, refined: m.refined || 0, passes: m.passes || 0, errSamples: m.errSamples || [], ml: m.ml || [], route: m.route || [], robustnessLogs: m.robustnessLogs || [] });
      }
    };
    (w as any).onerror = (e: any) => { settle(); try { w.terminate(); } catch { /* noop */ } worker = null; rejecter = null; reject(e.message || e); };
    w.postMessage({
      type: 'run', symbol: sym, t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v,
      und: undData ? { t: undData.t, o: undData.o, h: undData.h, l: undData.l, c: undData.c, v: undData.v } : null,
      grid, tradeOpts: opts, objective, topN, paramSteps: paramSteps || {},
      slStep: risk && risk.sl ? stepsOf(risk.sl) : 0,
      tpStep: risk && risk.tp ? stepsOf(risk.tp) : 0,
      useBayes: (useStore.getState() as any).bayesRefine !== false,
    });
  });
}

async function runAsync(grid: any[], opts: any, objective: string, topN: number,
  onBatch: (done: number, total: number | string, top: BoardRow[], cur: any, stage: string, pass: number) => void,
  paramSteps: any, risk: any, mySeq: number, dataSrc?: OHLCV, sym: string = '') {
  const data = (dataSrc || useStore.getState().data) as OHLCV;
  let tfCache: any = null, sigCache: any = { key: null, sig: null };
  const undRaw = opts.sigSource === 'underlying' ? ((underlyingFor(sym) || [])[1] || data) : null;
  const res: BoardRow[] = [];
  const getTF = (tf: number) => {
    if (!tfCache || tfCache.tf !== tf) {
      const d = engine.resample(data, tf);
      let mi = engine.buildSessionMask(d, opts.sessionStart, opts.sessionEnd);
      mi = engine.combineMasks(mi, engine.buildExpiryMask(d, opts.excludeExpiry)) as Int8Array;
      if (opts.ivMaxRank != null && opts.ivMaxRank < 1) {
        const ivm = engine.ivRankMask(d, opts.ivMaxRank, 20, 75600);
        logLine(ivm.insufficient
          ? `  route: ${tf}m IV-rank insufficient history — filter inactive`
          : `  route: ${tf}m IV-rank filter ≤${opts.ivMaxRank}`);
        mi = engine.combineMasks(mi, ivm.mask) as Int8Array;
      }
      tfCache = { tf, d, maskIn: mi, maskCarry: new Int8Array(d.c.length).fill(1) };
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
    const sk = (opts.sigSource === 'underlying' ? 'U:' : '') + cfg.timeframe + '|' + cfg.indicator + '|' + JSON.stringify(cfg.params);
    if (sigCache.key !== sk) {
      if (opts.sigSource === 'underlying' && undRaw) {
        const al = engine.underlyingSignal(tfc.d, undRaw, cfg.timeframe, cfg);
        sigCache = { key: sk, sig: { pos: al.pos } };
      } else sigCache = { key: sk, sig: engine.buildSignals(tfc.d, cfg) };
    }
    const bt = engine.backtest(d, sigCache.sig.pos, eff);
    return {
      i: idx, symbol: sym, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params,
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
      res.push({ i, symbol: sym, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params, slPct: cfg.slPct || 0, tpPct: cfg.tpPct || 0, trailPct: 0, exit: cfg.exit || 'fixed', carry: !!cfg.carry, refined: false, m: { netPnL: 0, winRate: 0, totalTrades: 0, profitFactor: 0, maxDD: 0, sharpe: -99, sortino: -99, expectancy: 0, finalCapital: opts.capital || 100000, tradesPerDay: 0, days: 0 } as any, err: String((err as any)?.message || err) });
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
  // Bayesian EI pass (GP over evaluated top rows, deterministic proposals).
  if ((useStore.getState() as any).bayesRefine !== false && !useStore.getState().stoppedFlag) {
    try {
      const cands = engine.bayesianRefine(engine.rankResults(res, objective).slice(0, 40), paramSteps || {}, 24)
        .filter((nb: any) => !tested.has(engine.cfgKey(nb)));
      for (const nb of cands) tested.add(engine.cfgKey(nb));
      for (let j = 0; j < cands.length; j++) {
        if (useStore.getState().runSeq !== mySeq) return { top: engine.rankResults(res, objective).slice(0, topN), refined, passes: pass, stopped: true };
        try { res.push(testCfg(cands[j], grid.length + refined, true)); }
        catch { const s = useStore.getState(); s.set({ run: { ...s.run, errCount: s.run.errCount + 1 } }); }
        refined++;
      }
      if (cands.length) logLine(`  bayes: +${cands.length} EI proposals evaluated (fallback path)`);
      pass++;
    } catch { /* best-effort */ }
  }
  return { top: engine.rankResults(res, objective).slice(0, topN), refined, passes: pass, stopped: false };
}

// Walk-forward verify: re-run top rows on the untouched OOS tail (same config,
// same regime routing). Rows gain oosNet/oosWR/oosN/survived. Cheap: ≤200 runs.
export async function wfVerify(rows: BoardRow[], opts: any, mySeq: number) {
  const st = useStore.getState();
  const bySym: Record<string, BoardRow[]> = {};
  for (const r of rows.slice(0, 200)) {
    const k = r.symbol || st.symbol || 'DATA';
    (bySym[k] = bySym[k] || []).push(r);
  }
  const filt = (raw: OHLCV): OHLCV => {
    if (!st.fromDate && !st.toDate) return raw;
    const lo = st.fromDate ? new Date(st.fromDate + 'T00:00:00').getTime() : -Infinity;
    const hi = st.toDate ? new Date(st.toDate + 'T23:59:59').getTime() : Infinity;
    const idx: number[] = [];
    for (let i = 0; i < raw.t.length; i++) if (raw.t[i] >= lo && raw.t[i] <= hi) idx.push(i);
    const pk = (a: Float64Array) => Float64Array.from(idx.map(i => a[i]));
    return { t: pk(raw.t), o: pk(raw.o), h: pk(raw.h), l: pk(raw.l), c: pk(raw.c), v: pk(raw.v) };
  };
  let total = 0, surv = 0;
  for (const sym of Object.keys(bySym)) {
    if (useStore.getState().runSeq !== mySeq) return 'aborted';
    const ds = st.datasets[sym];
    const data = ds ? filt(ds.raw) : st.data;
    if (!data || data.t.length < 100) continue;
    const splitT = data.t[0] + (st.wfSplit / 100) * (data.t[data.t.length - 1] - data.t[0]);
    let si = 0;
    while (si < data.t.length && data.t[si] < splitT) si++;
    // Purged WF: skip purgeBars after the split (indicator warmup/ATR windows
    // must not leak IS structure into OOS), drop embargoBars off the tail.
    const purge = Math.max(0, Math.round(st.purgeBars || 0));
    const embargo = Math.max(0, Math.round(st.embargoBars || 0));
    si = Math.min(data.t.length - 1, si + purge);
    const ei = Math.max(si + 50, data.t.length - embargo);
    if (purge || embargo) logLine(`  WF [${sym}]: purged ${purge} bars @ split, embargo ${embargo} bars @ tail`);
    const pick = (a: Float64Array) => a.slice(si, ei);
    const oos = { t: pick(data.t), o: pick(data.o), h: pick(data.h), l: pick(data.l), c: pick(data.c), v: pick(data.v) };
    if (oos.t.length < 50) continue;
    // Folded OOS: split the tail into ≤3 contiguous folds so survival is
    // proven across sub-periods, not one lucky stretch. Folds with <5 trades
    // are skipped (thin), never counted as failures.
    const N_FOLDS = oos.t.length >= 300 ? 3 : 1;
    const foldOf = (a: Float64Array, fi: number) => {
      const s0 = Math.floor(oos.t.length * fi / N_FOLDS), s1 = Math.floor(oos.t.length * (fi + 1) / N_FOLDS);
      return a.slice(s0, s1);
    };
    const foldData = (fi: number) => ({ t: foldOf(oos.t, fi), o: foldOf(oos.o, fi), h: foldOf(oos.h, fi), l: foldOf(oos.l, fi), c: foldOf(oos.c, fi), v: foldOf(oos.v, fi) });
    const tfCache: Record<string, any> = {};
    const wfRouteCaches: Record<string, Record<number, any>> = {};
    const getTFF = (tf: number, fi: number) => {
      const k = tf + 'f' + fi;
      if (!tfCache[k]) {
        const d = engine.resample(foldData(fi) as any, tf);
        let mi = engine.buildSessionMask(d, opts.sessionStart, opts.sessionEnd);
        mi = engine.combineMasks(mi, engine.buildExpiryMask(d, opts.excludeExpiry)) as Int8Array;
        if (opts.ivMaxRank != null && opts.ivMaxRank < 1) mi = engine.combineMasks(mi, engine.ivRankMask(d, opts.ivMaxRank, 20, 75600).mask) as Int8Array;
        tfCache[k] = { d, maskIn: mi, maskCarry: new Int8Array(d.c.length).fill(1) };
        wfRouteCaches[k] = {};
      }
      return tfCache[k];
    };
    const evalFold = (r: BoardRow, fi: number) => {
      const tfc = getTFF(r.timeframe, fi);
      if (tfc.d.t.length < 20) return { net: 0, wr: 0, n: 0, skipped: true };
      const eff: any = Object.assign({}, opts, {
        sessionMask: r.carry ? tfc.maskCarry : tfc.maskIn,
        slPct: r.slPct, tpPct: r.tpPct, trailPct: r.trailPct ?? opts.trailPct,
        exit: r.exit || 'fixed', carry: !!r.carry,
      });
      const xo = engine.exitOptsFromParams(r.indicator, r.params || {});
      if (xo) { eff.ckPeriod = xo.ckPeriod; eff.ckMult = xo.ckMult; }
      const routed = routingFor(wfRouteCaches[r.timeframe + 'f' + fi], r.timeframe, tfc.d, r, eff);
      if (routed.mask) eff.tradeMask = routed.mask;
      const sig = engine.buildSignals(tfc.d, { indicator: r.indicator, params: r.params });
      const bt = engine.backtest(tfc.d, sig.pos, eff);
      const n = bt.metrics.totalTrades;
      return { net: bt.metrics.netPnL, wr: bt.metrics.winRate, n, sharpe: bt.metrics.sharpe, skipped: n < 5 };
    };
    for (const r of bySym[sym]) {
      if (useStore.getState().runSeq !== mySeq) return 'aborted';
      const folds = [];
      for (let fi = 0; fi < N_FOLDS; fi++) folds.push(evalFold(r, fi));
      const live = folds.filter(f => !f.skipped);
      const totN = live.reduce((a, f) => a + f.n, 0);
      r.oosNet = live.reduce((a, f) => a + f.net, 0);
      r.oosN = totN;
      r.oosWR = totN ? live.reduce((a, f) => a + f.wr * f.n, 0) / totN : 0;
      r.oosFolds = folds;
      r.survived = live.length ? live.every(f => f.net > 0) : null;
      total++;
      if (r.survived) surv++;
      if (total % 25 === 0) await new Promise(rr => setTimeout(rr, 0));
    }
    const symRows = bySym[sym];
    const symSurv = symRows.filter(r => r.survived).length;
    const liveFolds = symRows.flatMap(r => (r.oosFolds || []).filter(f => !f.skipped));
    const foldWin = liveFolds.filter(x => x.net > 0).length;
    const thinFolds = symRows.flatMap(r => (r.oosFolds || []).filter(f => f.skipped)).length;
    const foldShr = liveFolds.length ? ` mean_fold_sharpe=${(liveFolds.reduce((a, f) => a + (f.sharpe || 0), 0) / liveFolds.length).toFixed(2)}` : '';
    logLine(`  WF [${sym}]: ${symSurv}/${symRows.length} rows survived OOS (${N_FOLDS} folds/row: ${foldWin}/${liveFolds.length} fold-wins${thinFolds ? `, ${thinFolds} thin-skipped(<5 trades)` : ''}${foldShr})`);
  }
  return `WF ${st.wfSplit}/${100 - st.wfSplit}: ${surv}/${total} rows survived OOS`;
}

export async function runGrid() {
  const st = useStore.getState();
  const syms = enabledSymbols();
  if (!syms.length) { st.set({ alert: 'No market data — upload 1-min CSV file(s) before running a search.' }); return; }
  const { sels, paramSteps } = buildSelection();
  if (!sels.length) { st.set({ alert: 'No indicators selected — enable at least one strategy.' }); return; }
  const risk = buildRisk();
  const dims = buildDims();
  let grid = st.gridMode === 'halton'
    ? engine.buildHaltonGrid(sels, risk, dims, st.haltonN)
    : engine.buildGrid(sels, risk, dims);
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
  const useBayes = st.bayesRefine;
  // Per-symbol execution data (WF in-sample slice when enabled; detail views
  // stay full-data). Single-symbol runs behave exactly as before.
  const symData: [string, OHLCV][] = syms.map(([sym, d]) => {
    if (st.wfOn && d.t.length > 200) {
      const d0 = d.t[0], d1 = d.t[d.t.length - 1];
      const cut = d0 + (st.wfSplit / 100) * (d1 - d0);
      let si = 0;
      while (si < d.t.length && d.t[si] < cut) si++;
      const pk = (a: Float64Array) => a.slice(0, si);
      return [sym, { t: pk(d.t), o: pk(d.o), h: pk(d.h), l: pk(d.l), c: pk(d.c), v: pk(d.v) }];
    }
    return [sym, d];
  });
  const wfNote = st.wfOn ? ` WF ${st.wfSplit}/${100 - st.wfSplit}` : '';
  const samplerNote = st.gridMode === 'halton' ? ` halton${st.haltonN}` : ' cartesian';
  const v2Note = opts.routerV2 ? ` routerv2(${opts.routerPersist}+${opts.routerHyst})` : '';
  const purgeNote = (opts.purgeBars || opts.embargoBars) ? ` purge${opts.purgeBars}/emb${opts.embargoBars}` : '';
  // Family diversity readout (descriptive — never a score).
  const famCount: Record<string, number> = {};
  for (const s of sels) {
    const f = (((engine as any).FAMILY || {})[s.indicator] || '?') as string;
    famCount[f] = (famCount[f] || 0) + 1;
  }
  const famLine = Object.entries(famCount).map(([f, n]) => `${f}×${n}`).join(' ');
  const grandTotal = grid.length * symData.length;
  const mySeq = seq + 1; seq = mySeq;
  // NOTE: never mutate a captured snapshot (st.* = …) — any set() in between
  // (e.g. logLine) replaces the state object and silently drops the write,
  // which used to wedge runs at "warming up" forever. Always use set().
  useStore.getState().set({ runSeq: mySeq });
  st.set({ alert: null });
  const t0 = performance.now();
  let lastRender = 0;
  const setRun = (p: Partial<typeof st.run>) => useStore.getState().set({ run: { ...useStore.getState().run, ...p } });
  setRun({ running: true, done: 0, total: grandTotal, stage: 'grid', pass: 0, perSec: 0, eta: '', current: 'warming up…', errCount: 0, refined: 0, passes: 0, summary: `0 / ${grandTotal}` });
  logLine(`run start: ${syms.map(([s, d]) => `${s} ${(d.t.length / 1000).toFixed(0)}k`).join(' + ')} bars ex=${opts.exchange}(${opts.sessionStart}→${opts.sessionEnd})` + ` tz=Asia/Kolkata(pinned) resample=O/H/L/C/V sig=${opts.sigSource || 'prices'} fams=[${famLine}] objective=${objective} dir=${opts.direction}/${opts.entry}/${opts.fill} exits=[${dims.exits.join(',')}] sess=${dims.carry.length > 1 ? 'day+carry' : dims.carry[0] ? 'carry' : 'day'} regime=${opts.regimeOn ? opts.regimeSource + '/' + (opts.granularity || 'day') : 'off'}${wfNote}${samplerNote}${v2Note}${purgeNote} cap=${opts.capital} qty=${opts.qty}x${opts.lotSize} cost=${opts.cost}${opts.costMode === 'signal' ? '(ZERO-RESEARCH)' : ''}${opts.premiumFloor ? ` premFloor=${opts.premiumFloor}` : ''}${opts.ivMaxRank != null && opts.ivMaxRank < 1 ? ` ivRank≤${opts.ivMaxRank}` : ''}${opts.excludeExpiry ? ' noExpiryDay' : ''} grid=${grid.length}x${symData.length}sym`);
  try {
    const dh = dataHealth();
    logLine(`  data health: ${dh.symbols} symbols · ${(dh.bars / 1000).toFixed(0)}k bars · ${dh.sessions} sessions · ${dh.spanDays}d span${dh.contracts ? ` · ${dh.contracts} contracts/${dh.expiries.length} expiries` : ''} — ` + dh.verdicts.map(v => `${v.ok ? 'PASS' : 'FAIL'} ${v.label} (${v.detail})`).join(' · '));
  } catch { /* best-effort */ }
  const onBatch = (done: number, total: number | string, top: BoardRow[], current: any, stage: string, pass: number) => {
    if (useStore.getState().runSeq !== mySeq) return;
    if (stage === 'refine' && !useStore.getState()._refineAt) useStore.getState().set({ _refineAt: performance.now() });
    const pct = typeof done === 'number' && typeof total === 'number' ? ((done / total) * 100).toFixed(1) : '—';
    const el = (performance.now() - t0) / 1000;
    const perSec = (typeof done === 'number' ? done : 0) / Math.max(0.5, el);
    let eta = '';
    if (stage !== 'refine' && typeof done === 'number' && typeof total === 'number' && done > 5 && perSec > 0) {
      const s = Math.round((total - done) / perSec);
      eta = ` · ETA ${fmtETA(s)}`;
    }
    const cur = current ? `${stage === 'refine' ? '🔁 refining best:' : '⚙ now running:'} ${current.sym ? `[${current.sym}] ` : ''}${current.indicator} ${current.timeframe}m · ${fmtParams(current.params)}${current.slPct != null ? ` · SL ${current.slPct}% TP ${current.tpPct}%` : ''}${current.exit ? ` · ${EXIT_LBL[current.exit] || current.exit}${current.carry ? '+carry' : ''}` : ''}` : '';
    setRun({ done: typeof done === 'number' ? done : 0, total, perSec, eta, current: cur, summary: `${done} / ${total}${stage === 'refine' ? ` · refine pass ${pass || ''}` : ''} (${pct}%) · ${perSec.toFixed(0)}/s${eta}` });
    useStore.getState().set({ board: top });
    const now = performance.now();
    if (now - lastRender > 700 || done === total) { lastRender = now; useStore.getState().set({ boardTick: useStore.getState().boardTick + 1 }); }
    const s2 = useStore.getState();
    if (top.length && !s2.detail) selectRow(top[0], true);
  };
  let top: BoardRow[] = [], refineInfo = '', errSamples: any[] = [], runMode = 'worker', stopped = false;
  let refinedN = 0, passesN = 0;
  let mlInfo: any[] = [], routeInfo: string[] = [], robustnessLogs: string[] = [];
  const allRows: BoardRow[] = [];
  useStore.getState().set({ _refineAt: null });
  let doneBase = 0;
  for (const [sym, sData] of symData) {
    if (useStore.getState().runSeq !== mySeq || useStore.getState().stoppedFlag) break;
    const wrapBatch = (done: number, total: number | string, btop: BoardRow[], cur: any, stage: string, pass: number) => {
      const gDone = typeof done === 'number' ? doneBase + done : done;
      onBatch(gDone, grandTotal, btop, cur ? { ...cur, sym } : cur, stage, pass);
    };
    try {
      const undPair: [string, OHLCV] | null = opts.sigSource === 'underlying' ? (underlyingFor(sym) || [sym, sData]) : null;
      if (opts.sigSource === 'underlying' && undPair) logLine(`[${sym}] signal source: UNDERLYING ${undPair[0]} → execute ${sym} (causal last-known align)`);
      const out = await runWithWorker(grid, sData, sym, opts, objective, topN, wrapBatch, paramSteps, risk, undPair ? undPair[1] : null);
      allRows.push(...out.top);
      refineInfo += out.refined ? ` · ${sym}+${out.refined}r` : '';
      errSamples.push(...(out.errSamples || []));
      refinedN += out.refined || 0; passesN = Math.max(passesN, out.passes || 0);
      mlInfo.push(...(out.ml || []).map((m: any) => ({ ...m, sym })));
      routeInfo.push(...((out as any).route || []).map((n: string) => `[${sym}] ${n}`));
      robustnessLogs.push(...((out as any).robustnessLogs || []));
      if (useStore.getState().runSeq === mySeq) {
        useStore.getState().set({ board: engine.rankResults(allRows, objective).slice(0, topN) });
      }
    } catch (err: any) {
      if (useStore.getState().stoppedFlag) break;
      logLine(`[${sym}] worker unavailable (${err?.message || err}) — main-thread fallback`);
      runMode = 'fallback';
      try {
        const out = await runAsync(grid, opts, objective, topN, wrapBatch, paramSteps, risk, mySeq, sData, sym);
        allRows.push(...out.top);
        refineInfo += out.refined ? ` · ${sym}+${out.refined}r` : '';
        stopped = !!out.stopped;
        refinedN += out.refined || 0; passesN = Math.max(passesN, out.passes || 0);
        if (stopped) break;
      } catch (err2: any) {
        setRun({ running: false, summary: `❌ ERROR on ${sym}: ${(err2?.message || err2)}` });
        useStore.getState().set({ alert: `Grid search failed on ${sym}: ${(err2?.message || err2)} — see console (F12).` });
        logLine(`run ERROR [${sym}]: ${(err2?.message || err2)}`);
        return;
      }
    }
    doneBase += grid.length;
  }
  // STAGE-2 discovery: AND-pairs of top singles (same symbol + timeframe).
  // Pairs are first-class rows (indicator='PAIR', legs in params) so detail,
  // WF, robustness and export paths work unchanged. Capped, logged, honest.
  try {
    const tfCacheP: Record<string, any> = {};
    const routeCacheP: Record<string, Record<number, any>> = {};
    const evalPair = (sym: string, tf: number, legA: BoardRow, legB: BoardRow): BoardRow | null => {
      const sd = symData.find(([s]) => s === sym);
      if (!sd) return null;
      const key = sym + '|' + tf;
      if (!tfCacheP[key]) {
        const d = engine.resample(sd[1], tf);
        let mi = engine.buildSessionMask(d, opts.sessionStart, opts.sessionEnd);
        mi = engine.combineMasks(mi, engine.buildWindowMask(d.t, opts.tradeWindows)) as Int8Array;
        mi = engine.combineMasks(mi, engine.buildExpiryMask(d, opts.excludeExpiry)) as Int8Array;
        if (opts.ivMaxRank != null && opts.ivMaxRank < 1) mi = engine.combineMasks(mi, engine.ivRankMask(d, opts.ivMaxRank, 20, 75600).mask) as Int8Array;
        tfCacheP[key] = { d, mi };
      }
      const { d, mi } = tfCacheP[key];
      const pairCfg = { indicator: 'PAIR', params: { a: legA.indicator, ap: JSON.stringify(legA.params || {}), b: legB.indicator, bp: JSON.stringify(legB.params || {}) } };
      const sig = engine.buildSignals(d, pairCfg);
      const eff: any = Object.assign({}, opts, {
        sessionMask: legA.carry ? new Int8Array(d.c.length).fill(1) : mi,
        slPct: legA.slPct, tpPct: legA.tpPct, trailPct: legA.trailPct ?? opts.trailPct,
        exit: legA.exit || 'fixed', carry: !!legA.carry,
      });
      const rc = routeCacheP[key] || (routeCacheP[key] = {});
      const routed = routingFor(rc, tf, d, pairCfg as any, eff);
      if (routed.mask) eff.tradeMask = routed.mask;
      const bt = engine.backtest(d, sig.pos, eff);
      if (!bt.metrics.totalTrades) return null;
      return {
        i: -1, symbol: sym, timeframe: tf, indicator: 'PAIR', params: pairCfg.params,
        slPct: eff.slPct || 0, tpPct: eff.tpPct || 0, trailPct: eff.trailPct || 0,
        exit: eff.exit, carry: eff.carry, refined: false, pair: true, m: bt.metrics,
      };
    };
    const bySymP: Record<string, BoardRow[]> = {};
    for (const r of allRows) {
      if (!r.m || !r.m.totalTrades || r.indicator === 'PAIR') continue;
      (bySymP[r.symbol || ''] = bySymP[r.symbol || ''] || []).push(r);
    }
    let evalN = 0, keptN = 0;
    const CAP = 200;
    for (const sym of Object.keys(bySymP)) {
      if (useStore.getState().runSeq !== mySeq) break;
      const legs = bySymP[sym].sort((a, b) => engine.objectiveValue(b.m, objective) - engine.objectiveValue(a.m, objective)).slice(0, 12);
      for (let x = 0; x < legs.length; x++) for (let y = x + 1; y < legs.length; y++) {
        if (legs[x].timeframe !== legs[y].timeframe) continue;
        if (evalN >= CAP) break;
        evalN++;
        const pr = evalPair(sym, legs[x].timeframe, legs[x], legs[y]);
        if (pr && pr.m.totalTrades >= 5) { pr.i = allRows.length; allRows.push(pr); keptN++; }
      }
      if (evalN >= CAP) break;
    }
    logLine(`pairs[stage-2]: evaluated=${evalN} kept=${keptN} (top-12/symbol, same-TF AND-agreement, n≥5)`);
  } catch (e: any) { logLine('pair stage skipped: ' + (e?.message || e)); }

  top = engine.rankResults(allRows, objective).slice(0, topN);
  // Research union: top-20 per research objective are ALWAYS retained on the
  // board, so no discovery (high-WR, high-P&L, …) can vanish merely because
  // another objective was configured. Raw ranks stamped BEFORE any demotion.
  try {
    const keep = new Map<string, BoardRow>();
    for (const r of top) keep.set(engine.cfgKey(r), r);
    let extra = 0;
    for (const [key] of (engine.RESEARCH_OBJS as [string, string][])) {
      for (const r of [...allRows].sort(engine.researchCmp(key)).slice(0, 20)) {
        const k = engine.cfgKey(r);
        if (!keep.has(k)) { keep.set(k, r); extra++; }
      }
    }
    top = [...keep.values()];
    if (extra) logLine(`research union: +${extra} rows retained (top-20 per objective beyond top-${topN})`);
  } catch (e: any) { logLine('research union skipped: ' + (e?.message || e)); }
  try {
    const fullRank = engine.rankResults(allRows, objective);
    const rankOf = new Map<string, number>();
    fullRank.forEach((r, i) => { if (!rankOf.has(engine.cfgKey(r))) rankOf.set(engine.cfgKey(r), i + 1); });
    for (const r of top) {
      r.rawRank = rankOf.get(engine.cfgKey(r));
      r.rawObjective = { key: objective, value: engine.objectiveValue(r.m, objective) };
    }
  } catch { /* best-effort stamping */ }
  // Ranking integrity: argmax over the COMPLETE evaluated set vs displayed
  // #1, per research objective. Any mismatch is a loud FAIL, never silent.
  try {
    const audit = engine.auditRankingIntegrity(allRows, top);
    const fails = audit.filter(a => !a.pass);
    audit.forEach(a => logLine(`  rank[${a.objective}]: ${a.pass ? 'PASS' : 'FAIL'} max=${a.maxValue} @${(a.maxRow || '').slice(0, 60)}`));
    logLine(fails.length ? `RANKING_INTEGRITY = FAIL (${fails.map(f => f.objective).join(',')})` : 'RANKING_INTEGRITY = PASS (5/5 objectives)');
  } catch (e: any) { logLine('ranking audit skipped: ' + (e?.message || e)); }
  // Knife-edge demotion (uniform across worker + fallback paths): PSS ≥ 0.5
  // sinks below every clean row. Reuses worker robustness evidence when
  // present; otherwise probes PSS directly (session filter off — curvature
  // is a signal property, noted in the log).
  try {
    const pssCache = new Map<string, number | null>();
    const tfDataCache: Record<string, any> = {};
    const pssOf = (r: BoardRow): number | null => {
      if (r.robustness && r.robustness.paramSensitivity) return r.robustness.paramSensitivity.pss;
      const k = engine.cfgKey(r);
      if (pssCache.has(k)) return pssCache.get(k) ?? null;
      try {
        const symD = symData.find(([s]) => s === (r.symbol || symData[0][0]));
        const src = symD ? symD[1] : symData[0][1];
        const dk = (r.symbol || '') + '|' + r.timeframe;
        if (!tfDataCache[dk]) tfDataCache[dk] = engine.resample(src, r.timeframe);
        const d = tfDataCache[dk];
        const base = tradeOpts();
        const eff = Object.assign({}, base, {
          sessionMask: new Int8Array(d.c.length).fill(1),
          slPct: r.slPct, tpPct: r.tpPct, trailPct: r.trailPct ?? base.trailPct,
          exit: r.exit || 'fixed', carry: !!r.carry,
        });
        const s = Robust.paramSensitivity(d, r.indicator, r.params, eff);
        pssCache.set(k, s.pss);
        return s.pss;
      } catch { pssCache.set(k, null); return null; }
    };
    const head = top.slice(0, 25);
    const demoted = engine.demoteKnifeEdge(head, pssOf);
    const nEdge = head.filter(r => { const p = pssOf(r); return p != null && isFinite(p) && p >= 0.5; }).length;
    if (nEdge) logLine(`[KNIFE-EDGE] demoted=${nEdge}/25 knife-edge rows below clean rows (PSS≥0.5)`);
    top = demoted.concat(top.slice(25));
  } catch (e: any) { logLine('knife-edge pass skipped: ' + (e?.message || e)); }
  // Full robustness for top-3 PAIR rows (stage-2 rows miss the worker suite).
  // Exact execution: session/expiry/IV/window masks + regime tradeMask.
  try {
    const pairTops = top.filter(r => r.indicator === 'PAIR' && !r.robustness).slice(0, 3);
    const rbCache: Record<string, any> = {};
    const rbRoute: Record<string, Record<number, any>> = {};
    for (const pr of pairTops) {
      if (useStore.getState().runSeq !== mySeq) break;
      const symD = symData.find(([s]) => s === (pr.symbol || symData[0][0]));
      const src = symD ? symD[1] : symData[0][1];
      const dk = (pr.symbol || '') + '|' + pr.timeframe;
      if (!rbCache[dk]) { rbCache[dk] = engine.resample(src, pr.timeframe); rbRoute[dk] = {}; }
      const d = rbCache[dk];
      const base = tradeOpts();
      let mi = engine.buildSessionMask(d, base.sessionStart, base.sessionEnd);
      mi = engine.combineMasks(mi, engine.buildWindowMask(d.t, base.tradeWindows)) as Int8Array;
      mi = engine.combineMasks(mi, engine.buildExpiryMask(d, base.excludeExpiry)) as Int8Array;
      if (base.ivMaxRank != null && base.ivMaxRank < 1) mi = engine.combineMasks(mi, engine.ivRankMask(d, base.ivMaxRank, 20, 75600).mask) as Int8Array;
      const eff: any = Object.assign({}, base, {
        sessionMask: pr.carry ? new Int8Array(d.c.length).fill(1) : mi,
        slPct: pr.slPct, tpPct: pr.tpPct, trailPct: pr.trailPct ?? base.trailPct,
        exit: pr.exit || 'fixed', carry: !!pr.carry,
      });
      const routed = routingFor(rbRoute[dk], pr.timeframe, d, pr, eff);
      if (routed.mask) eff.tradeMask = routed.mask;
      const r = await Robust.robustnessFor(d, pr, eff, null, grid.length * symData.length, top.indexOf(pr) + 1);
      pr.robustness = r;
      pr.robustScore = r.final.adjusted;
      logLine(`  pair-robust [${pr.symbol}] PAIR n=${r.baseline.totalTrades} WR=${r.baseline.winRate.toFixed(1)}% score=${(pr.robustScore || 0).toFixed(2)}/10 (${r.classification})`);
    }
  } catch (e: any) { logLine('pair robustness skipped: ' + (e?.message || e)); }
  // Log candidate headers for top 5 (machine-readable, §2)
  {
    const totalCombos = grid.length * symData.length;
    top.slice(0, 5).forEach((r, idx) => {
      logLine(formatCandidateHeader(r, totalCombos, idx + 1, objective, opts));
      logLine(formatCoreSignal(r));
    });
  }
  // CONFIG_IDENTITY: candidate row == core display == robustness config.
  // Rebuilds the robustness execution via effOptsFor and diffs every field.
  try {
    const champ = top[0];
    if (champ) {
      const symD = symData.find(([s]) => s === (champ.symbol || symData[0][0]));
      const src = symD ? symD[1] : symData[0][1];
      const dd = engine.resample(src, champ.timeframe);
      const eff = Robust.effOptsFor(champ, opts, dd);
      const diffs: string[] = [];
      const cmp = (name: string, a: any, b: any) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${name}: row=${JSON.stringify(a)} robust=${JSON.stringify(b)}`); };
      // indicator+params travel as direct backtest args (same object — cannot
      // diverge); everything below is reconstructed, so any drift is real.
      cmp('slPct', champ.slPct ?? opts.slPct ?? 0, eff.slPct ?? 0);
      cmp('tpPct', champ.tpPct ?? opts.tpPct ?? 0, eff.tpPct ?? 0);
      cmp('trailPct', champ.trailPct ?? opts.trailPct ?? 0, eff.trailPct ?? 0);
      cmp('exit', champ.exit || 'fixed', eff.exit || 'fixed');
      cmp('carry', !!champ.carry, !!eff.carry);
      cmp('direction', opts.direction, eff.direction);
      cmp('fill', opts.fill, eff.fill);
      cmp('entry', opts.entry, eff.entry);
      cmp('cost', opts.cost, eff.cost);
      cmp('sessionMaskLen', dd.c.length, (eff.sessionMask || []).length || dd.c.length);
      logLine(diffs.length
        ? `CONFIG_IDENTITY = FAIL :: ${diffs.join(' · ')}`
        : `CONFIG_IDENTITY = PASS :: ${engine.cfgKey(champ).slice(0, 100)} (candidate=core=robustness=display)`);
    }
  } catch (e: any) { logLine('CONFIG_IDENTITY = SKIP (' + (e?.message || e) + ')'); }
  useStore.getState().set({ board: top });
  const s3 = useStore.getState();
  if (s3.stoppedFlag) stopped = true;
  useStore.getState().set({ stoppedFlag: false });
  worker = null;
  if (s3.runSeq !== mySeq && !stopped) {
    // Stale run superseded — never leave the switch stuck on "running".
    setRun({ running: false, summary: 'superseded by a newer run' });
    return;
  }
  const secs = (performance.now() - t0) / 1000;
  const gridSecs = s3._refineAt ? (s3._refineAt - t0) / 1000 : secs;
  const tested = doneBase;
  if (stopped) {
    const b = useStore.getState().board;
    setRun({ running: false, summary: `■ stopped by user — partial board kept (${b.length} rows, ${tested} combos)` });
    logLine(`run STOPPED by user after ${secs.toFixed(1)}s (${tested} combos) — partial board kept`);
    useStore.getState().set({ alert: `Search stopped — showing partial results (${b.length} rows).` });
  } else {
    const errs = useStore.getState().run.errCount;
    routeInfo.forEach((n: string) => logLine(`  route: ${n}`));
    mlInfo.forEach((m: any) => logLine(`  ML regime ${m.tf}m: train-acc ${(m.trainAcc * 100).toFixed(1)}% in ${m.ms}ms`));
    if (robustnessLogs.length) robustnessLogs.forEach(l => logLine(l));
    let wfMsg = '';
    if (st.wfOn && !stopped) {
      setRun({ summary: `done · verifying top-200 out-of-sample…` });
      wfMsg = await wfVerify(useStore.getState().board, opts, mySeq);
      logLine(wfMsg);
      useStore.getState().set({ board: useStore.getState().board });
    }
    setRun({ running: false, refined: 0, passes: 0, summary: `done · ${tested} combos in ${secs.toFixed(1)}s${refineInfo}${errs ? ` · ⚠ ${errs} errored` : ''}${wfMsg ? ` · ${wfMsg}` : ''}` });
    logLine(`run done (${runMode}): ${tested} combos in ${secs.toFixed(1)}s [grid ${gridSecs.toFixed(1)}s${s3._refineAt ? ` + refine ${(secs - gridSecs).toFixed(1)}s` : ''}] ${(tested / Math.max(secs, 0.01)).toFixed(0)}/s objective=${objective} errors=${errs}${refineInfo}${wfMsg ? ' · ' + wfMsg : ''}`);
    errSamples.forEach((e: any) => logLine(`  combo error: ${e}`));
  }
  const bd = useStore.getState().board;
  bd.slice(0, 3).forEach((r, i) => logLine(`  #${i + 1} [${r.symbol || '?'}] ${r.timeframe}m ${r.indicator} ${fmtParams(r.params)} SL=${r.slPct} TP=${r.tpPct} WR=${r.m.winRate.toFixed(1)}% n=${r.m.totalTrades} pnl=${r.m.netPnL.toFixed(0)}`));
  // Agent-grade complete summary: config used + best + top-5 + environment
  try {
    const sL = useStore.getState();
    const best = bd[0] || null;
    let stress: any = null;
    if (best) {
      try {
        const det = detailFor(best);
        if (det && det.bt.trades.length) {
          const { monteCarloDD, streakStats, heatmap, excursionStats, HEAT_BUCKETS_MCX } = await import('./stress');
          const mc = monteCarloDD(det.bt.trades, opts.capital, 1000, 42);
          const sk = streakStats(det.bt.trades);
          const ht = heatmap(det.bt.trades, opts.exchange === 'MCX' ? HEAT_BUCKETS_MCX : undefined);
          const ex = excursionStats(det.bt.trades);
          // best window: highest net pnl among windows with ≥5 trades, else best WR
          const rankedH = ht.slice().sort((a,b) => b.pnl - a.pnl);
          const bestH = rankedH.find(h => h.n >= 5) || rankedH[0] || null;
          stress = mc ? {
            mcN: mc.iters, mcP5: +mc.p5.toFixed(1), mcMed: +mc.p50.toFixed(1), mcWorst: +mc.worst.toFixed(1),
            maxLossStreak: sk.maxLossStreak, p4: +sk.p4.toFixed(3), p5: +sk.p5.toFixed(3), p6: +sk.p6.toFixed(3),
            avgMAE: ex ? Math.round(ex.avgMAE) : null, avgMFE: ex ? Math.round(ex.avgMFE) : null,
            heat: ht.map(h => ({ w: h.label, n: h.n, wr: +h.wr.toFixed(1), pnl: Math.round(h.pnl) })),
            bestTime: bestH ? { w: bestH.label, wr: +bestH.wr.toFixed(1), n: bestH.n, pnl: Math.round(bestH.pnl) } : null,
          } : null;
        }
      } catch { /* best-effort */ }
    }
    sL.set({
      lastRun: {
        at: new Date().toISOString(),
        stopped, mode: runMode, secs: +secs.toFixed(1),
        dataset: { symbols: syms.map(([ssx, dd]) => `${ssx} ${(dd.t.length / 1000).toFixed(0)}k`).join(' + '), from: sL.fromDate, to: sL.toDate },
        objective, topN, cap: sL.cap,
        exec: { direction: opts.direction, entry: opts.entry, fill: opts.fill, session: `${opts.sessionStart || '—'}→${opts.sessionEnd || '—'}`, exits: dims.exits, carry: dims.carry, regime: opts.regimeOn ? `${opts.regimeSource}/${opts.granularity || 'day'}` : 'off', confGate: opts.confGate },
        risk: { sl: risk ? risk.sl : [opts.slPct], tp: risk ? risk.tp : [opts.tpPct], trail: opts.trailPct, cost: opts.cost },
        sizing: { capital: opts.capital, qty: opts.qty, lot: opts.lotSize },
        grid: tested, refined: refinedN, passes: passesN, rate: +(grid.length / Math.max(secs, 0.01)).toFixed(0),
        errors: sL.run.errCount,
        best: best ? { sym: best.symbol, tf: best.timeframe, ind: best.indicator, params: best.params, sl: best.slPct, tp: best.tpPct, exit: best.exit, carry: best.carry, refined: !!best.refined, m: best.m, oos: { net: best.oosNet ?? null, wr: best.oosWR ?? null, n: best.oosN ?? null, survived: best.survived ?? null } } : null,
        bestPerSymbol: syms.map(([ssx]) => {
          const rb = bd.find(r => (r.symbol || '') === ssx) || null;
          return rb ? { sym: ssx, tf: rb.timeframe, ind: rb.indicator, wr: +rb.m.winRate.toFixed(1), n: rb.m.totalTrades, pnl: Math.round(rb.m.netPnL), sharpe: +rb.m.sharpe.toFixed(2) } : { sym: ssx, ind: null };
        }),
        top5: bd.slice(0, 5).map(r => ({ sym: r.symbol, tf: r.timeframe, ind: r.indicator, params: r.params, wr: +r.m.winRate.toFixed(1), n: r.m.totalTrades, pnl: Math.round(r.m.netPnL), dd: +r.m.maxDD.toFixed(2), sharpe: +r.m.sharpe.toFixed(2) })),
        stress,
      },
    });
    const L = useStore.getState().lastRun;
    logLine('===== RUN SUMMARY (agent-readable) =====');
    logLine(`when: ${L.at} · mode: ${L.mode} · duration: ${L.secs}s · rate: ${L.rate}/s · stopped: ${L.stopped}`);
    logLine(`datasets: ${L.dataset.symbols} ${L.dataset.from}→${L.dataset.to}`);
    logLine(`config: objective=${L.objective} topN=${L.topN} cap=${L.cap} dir=${L.exec.direction} entry=${L.exec.entry} fill=${L.exec.fill} session=${L.exec.session} exits=[${L.exec.exits}] carry=[${L.exec.carry}] regime=${L.exec.regime} confGate=${L.exec.confGate}`);
    logLine(`risk: SL=[${L.risk.sl}] TP=[${L.risk.tp}] trail=${L.risk.trail}% cost=${L.risk.cost}/trade · sizing: cap=${L.sizing.capital} qty=${L.sizing.qty}x${L.sizing.lot}`);
    logLine(`grid: ${L.grid} combos · refined=${L.refined} passes=${L.passes} · errors=${L.errors}`);
    if (L.best) logLine(`best: [${L.best.sym}] ${L.best.tf}m ${L.best.ind} ${fmtParams(L.best.params)} SL=${L.best.sl} TP=${L.best.tp} exit=${L.best.exit}${L.best.carry ? '+carry' : ''}${L.best.refined ? ' [refined]' : ''} WR=${L.best.m.winRate}% n=${L.best.m.totalTrades} pnl=${L.best.m.netPnL} dd=${L.best.m.maxDD}% sharpe=${L.best.m.sharpe} OOS=${L.best.oos.net ?? '—'}/${L.best.oos.survived ?? '—'}`);
    L.top5.forEach((t: any, i: number) => logLine(`  top${i + 1}: [${t.sym}] ${t.tf}m ${t.ind} WR=${t.wr}% n=${t.n} pnl=${t.pnl} dd=${t.dd}% sharpe=${t.sharpe}`));
    (L.bestPerSymbol || []).forEach((t: any) => logLine(t.ind ? `  best[${t.sym}]: ${t.tf}m ${t.ind} WR=${t.wr}% n=${t.n} pnl=${t.pnl} sharpe=${t.sharpe}` : `  best[${t.sym}]: no rows`));
    if (L.stress) {
      const S = L.stress;
      logLine(`stress[best]: MC1000 maxDD p5=${S.mcP5}% med=${S.mcMed}% worst=${S.mcWorst}% · lossStreak max=${S.maxLossStreak} P4=${(100 * S.p4).toFixed(1)}% P5=${(100 * S.p5).toFixed(1)}% P6=${(100 * S.p6).toFixed(1)}% · avgMAE=${S.avgMAE} avgMFE=${S.avgMFE}`);
      S.heat.forEach((h: any) => logLine(`  heat ${h.w}: n=${h.n} WR=${h.wr}% pnl=${h.pnl}`));
      if (S.bestTime) logLine(`  bestTime[best]: ${S.bestTime.w} WR=${S.bestTime.wr}% n=${S.bestTime.n} pnl=${S.bestTime.pnl}`);
    }
    logLine(`env: ${typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : 'node'}`);
    // BEST_* per research objective over the COMPLETE evaluated set (raw —
    // validation never hides these; WHY-NOT questions answer themselves here).
    try {
      for (const [key, label] of (engine.RESEARCH_OBJS as [string, string][])) {
        const br = [...allRows].sort(engine.researchCmp(key))[0];
        if (br) logLine(`  BEST_${label}: [${br.symbol || '?'}] ${br.timeframe}m ${br.indicator} ${fmtParams(br.params)} SL=${br.slPct} TP=${br.tpPct} exit=${br.exit || 'fixed'} value=${(engine.researchValue(br.m, key)).toFixed(2)} n=${br.m.totalTrades} wr=${br.m.winRate.toFixed(1)}%`);
      }
      const exitKinds = new Set(allRows.map(r => `${r.exit || 'fixed'}|${r.slPct}|${r.tpPct}|${r.trailPct || 0}|${r.carry ? 1 : 0}`));
      logLine(`  EXIT_SEARCH: ${exitKinds.size} distinct exit configs evaluated across ${allRows.length} rows`);
    } catch (e: any) { logLine('best-lists skipped: ' + (e?.message || e)); }
    logLine('===== RESEARCH RUN AUDIT =====');
    try {
      const dh = dataHealth();
      const sessions = new Set<string>();
      for (const [ , dd] of symData) {
        const step = Math.max(1, Math.floor(dd.t.length / 2000));
        for (let i = 0; i < dd.t.length; i += step) { const d = new Date(dd.t[i] + 19800000); sessions.add(d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate()); }
      }
      logLine(`MODE=${st.instrumentMode || 'futures'} DATASET=${syms.map(([s]) => s).join('+')} SESSIONS=${sessions.size} CONTRACTS=${dh.contracts || syms.length} EXPIRIES=${dh.expiries.length || 1} TIMEZONE=Asia/Kolkata(pinned) COST_MODE=${opts.costMode === 'signal' ? 'ZERO' : 'REAL(' + opts.cost + ')'}`);
      logLine(`CANDIDATES_GENERATED=${grid.length * symData.length} CANDIDATES_EVALUATED=${tested} CANDIDATES_DISPLAYED=${useStore.getState().board.length}`);
      logLine(`OPTIONS_RESEARCH_READY=${st.instrumentMode === 'options' ? 'YES' : 'N/A'} OPTIONS_VALIDATION_READY=NO GENERALIZATION=UNVERIFIED MULTI_EXPIRY=${dh.expiries.length > 1 ? 'AVAILABLE' : 'NOT_AVAILABLE'}`);
    } catch (e: any) { logLine('research audit skipped: ' + (e?.message || e)); }
    logLine('===== END SUMMARY =====');
  } catch (e: any) { logLine('summary build failed: ' + (e?.message || e)); }
  setRun({ current: '' });
  const s4 = useStore.getState();
  if (bd.length && !s4.userPickedSeq) selectRow(bd[0], true);
  // PAPER verdict for the champion (logged every run, regardless of adaptive).
  if (bd.length && !stopped) {
    const gate = engine.paperEligible(bd[0], { scoreThreshold: s4.paperThreshold ?? 9.5, cost: opts.cost, allowZeroCost: opts.costMode === 'signal' });
    useStore.getState().set({ lastPaper: gate });
    if (gate.eligible) logLine(`PAPER: ELIGIBLE — [${bd[0].symbol}] ${bd[0].timeframe}m ${bd[0].indicator} passed all gates${(gate.warnings || []).length ? ' (warnings: ' + (gate.warnings || []).join('; ') + ')' : ''}`);
    else logLine(`PAPER: BLOCKED — ${gate.reasons.join(' · ')}`);
  }
  // Adaptive tier escalation: Tier-A best must clear the HARD gate
  // (Sharpe base + robustness + surrogate + PSS + OOS), not raw Sharpe.
  if (s4.adaptive && !stopped && bd.length) {
    const verdict = tierGate(bd[0], opts);
    verdict.lines.forEach(l => logLine(l));
    if (!verdict.ok) {
      const cur = useStore.getState().inds;
      const hasB = Object.entries(cur).some(([k, v]) => IND_TIER[k] === 'B' && v.on);
      const hasC = Object.entries(cur).some(([k, v]) => IND_TIER[k] === 'C' && v.on);
      let next: string | null = null;
      if (!hasB) next = 'B';
      else if (!hasC) next = 'C';
      if (next) {
        logLine(`Adaptive: best Tier ${next === 'B' ? 'A' : 'A+B'} failed hard gate — auto-enabling Tier ${next} and re-running`);
        const nxt: any = { ...cur };
        for (const k of Object.keys(IND_TIER)) if (IND_TIER[k] === next) nxt[k] = { ...nxt[k], on: true };
        useStore.getState().set({ inds: nxt });
        setTimeout(() => runGrid(), 400);
      } else {
        logLine(`Adaptive: all tiers exhausted — champion still fails hard gate (see PAPER verdict above)`);
      }
    } else {
      logLine(`Adaptive: Tier ${hasTierLabel()} cleared hard gate — stopping`);
    }
  }
}

// Hard adaptive gate: raw Sharpe is necessary but never sufficient. With
// worker-path evidence present, robustness + surrogate + PSS + OOS are all
// required. Without evidence (main-thread fallback), falls back to the Sharpe
// gate with a loud warning.
export function tierGate(best: BoardRow, opts: any): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const st = useStore.getState();
  const th = st.paperThreshold ?? 9.5;
  const base = isGood(best.m);
  lines.push(`  gate[sharpe]: ${base ? 'PASS' : 'FAIL'} (sharpe=${best.m.sharpe.toFixed(2)} wr=${best.m.winRate.toFixed(1)}% pf=${best.m.profitFactor.toFixed(2)})`);
  if (best.robustScore == null) {
    lines.push('  gate[evidence]: MISSING (fallback path — no robustness computed) → Sharpe gate only, treat board as unverified');
    return { ok: base, lines };
  }
  const rb = best.robustness || {};
  const gScore = best.robustScore >= th;
  lines.push(`  gate[robust]: ${gScore ? 'PASS' : 'FAIL'} (${(best.robustScore || 0).toFixed(2)}/10 vs ${th})`);
  let gSurr = false;
  if (rb.surrogate == null) lines.push('  gate[surrogate]: MISSING');
  else if (rb.surrogate.skipped) lines.push('  gate[surrogate]: SKIP (<20 trades — edge unmeasurable, paper still blocked by sample gate)');
  else { gSurr = rb.surrogate.p < 0.01; lines.push(`  gate[surrogate]: ${gSurr ? 'PASS' : 'FAIL'} (p=${rb.surrogate.p})`); }
  let gPss = false;
  if (rb.paramSensitivity == null) lines.push('  gate[pss]: MISSING');
  else if (rb.paramSensitivity.skipped) lines.push(`  gate[pss]: SKIP (n=${rb.paramSensitivity.baseTrades}<30 — curvature meaningless on thin samples)`);
  else { gPss = !rb.paramSensitivity.knifeEdge; lines.push(`  gate[pss]: ${gPss ? 'PASS' : 'FAIL'} (pss=${rb.paramSensitivity.pss})`); }
  let gOos = false;
  if (!st.wfOn) lines.push('  gate[oos]: SKIP (walk-forward off — enable it for a real verdict)');
  else if (best.survived == null) lines.push('  gate[oos]: MISSING (thin OOS — no fold verdict)');
  else { gOos = !!best.survived; lines.push(`  gate[oos]: ${gOos ? 'PASS' : 'FAIL'} (survived=${best.survived})`); }
  const oosReq = st.wfOn ? gOos : true;
  return { ok: base && gScore && gSurr && gPss && oosReq, lines };
}

function hasTierLabel(): string {
  const cur = useStore.getState().inds;
  const onTiers = new Set(Object.entries(cur).filter(([_, v]: any) => v.on).map(([k]) => IND_TIER[k]));
  return [...onTiers].sort().join('+') || '—';
}

export function detailFor(r: BoardRow) {
  const st = useStore.getState();
  const ds = r.symbol ? st.datasets[r.symbol] : null;
  const src = ds ? filterData(ds.raw, st.fromDate, st.toDate) : st.data;
  if (!src || !src.t.length) return null;
  const d = engine.resample(src, r.timeframe);
  const sig = (() => {
    if (useStore.getState().sigSource === 'underlying') {
      const up = underlyingFor(r.symbol);
      // Charts show the OPTION series; signals come from the underlying.
      // Overlay/osc are empty (underlying legs live on another series).
      if (up) return { pos: engine.underlyingSignal(src, up[1], r.timeframe, { indicator: r.indicator, params: r.params }).pos, overlay: {}, osc: {} };
    }
    return engine.buildSignals(d, { indicator: r.indicator, params: r.params });
  })();
  const eff: any = tradeOpts();
  if (r.slPct != null) eff.slPct = r.slPct;
  if (r.tpPct != null) eff.tpPct = r.tpPct;
  if (r.trailPct != null) eff.trailPct = r.trailPct;
  eff.exit = r.exit || 'fixed'; eff.carry = !!r.carry;
  const xod = engine.exitOptsFromParams(r.indicator, r.params || {});
  if (xod) { eff.ckPeriod = xod.ckPeriod; eff.ckMult = xod.ckMult; }
  const routed = routingFor({}, r.timeframe, d, r, eff);
  if (routed.mask) eff.tradeMask = routed.mask;
  eff.sessionMask = engine.combineMasks(
    eff.carry ? new Int8Array(d.c.length).fill(1) : engine.buildSessionMask(d, eff.sessionStart, eff.sessionEnd),
    engine.buildWindowMask(d.t, eff.tradeWindows));
  eff.sessionMask = engine.combineMasks(eff.sessionMask, engine.buildExpiryMask(d, eff.excludeExpiry));
  if (eff.ivMaxRank != null && eff.ivMaxRank < 1) {
    eff.sessionMask = engine.combineMasks(eff.sessionMask, engine.ivRankMask(d, eff.ivMaxRank, 20, 75600).mask);
  }
  const bt = engine.backtest(d, sig.pos, eff);
  return { cfg: r, data: d, sig, bt };
}

export function selectRow(r: BoardRow, auto?: boolean) {
  const st = useStore.getState();
  if (!auto) useStore.getState().set({ userPickedSeq: st.runSeq || 0 });
  const det = detailFor(r);
  if (!det) return;
  useStore.getState().set({ sel: r, detail: det });
}

