// Grid-search runner: worker-first with main-thread fallback, stop support,
// live progress, hill-climb refinement. Faithful port of the validated logic.
import engine, { type BoardRow, type OHLCV } from './engine';
import { EXIT_LBL, IND_META, WIN_MAP } from './config';
import { useStore } from './store';
import { fmtMoney, fmtParams } from './format';
import { enabledSymbols, filterData, dataHealth } from './data';
import Robust from './robustness';
import { candidateId, formatCandidateHeader, formatCoreSignal, formatIsOos } from './report';
import { BUILD_INFO } from './buildinfo';

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

function heapNote(): string {
  try {
    const m = (performance as any)?.memory?.usedJSHeapSize;
    return m ? ` · heap ${Math.round(m / 1048576)}MB` : '';
  } catch { return ''; }
}

export function logLine(s: string) {
  const st = useStore.getState();
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  const log = [...st.log, `[${ts}] ${s}`];
  st.set({ log: log.length > 2000 ? log.slice(log.length - 2000) : log });
  // Crash-proof mirror: tab memory dies with Aw Snap, localStorage survives.
  // Ring buffer (500 lines) so a post-crash reload can still show/download
  // exactly where the run stopped.
  try {
    const k = 'xbost_log_v1';
    const prev = JSON.parse(localStorage.getItem(k) || '[]');
    prev.push(`[${ts}] ${s}`);
    while (prev.length > 500) prev.shift();
    localStorage.setItem(k, JSON.stringify(prev));
  } catch { /* storage blocked/private mode — session log still works */ }
}

export function recoveredLog(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('xbost_log_v1') || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function clearRecoveredLog() {
  try { localStorage.removeItem('xbost_log_v1'); } catch { /* noop */ }
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
  const runId = 'R' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
  // NOTE: never mutate a captured snapshot (st.* = …) — any set() in between
  // (e.g. logLine) replaces the state object and silently drops the write,
  // which used to wedge runs at "warming up" forever. Always use set().
  useStore.getState().set({ runSeq: mySeq, runId });
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
    // Stage logging: transitions logged once with timing + heap; robustness
    // (the longest silent phase) logs every 5th candidate. A stuck run thus
    // always shows WHERE it stopped — never silent.
    const stHeap = (() => {
      try {
        const m = (performance as any)?.memory?.usedJSHeapSize;
        return m ? ` heap=${Math.round(m / 1048576)}MB` : '';
      } catch { return ''; }
    })();
    const stEl = ((performance.now() - t0) / 1000).toFixed(1);
    const lastStage = (onBatch as any)._ls || '';
    const stageKey = stage + ':' + (pass || 0);
    if (stageKey !== lastStage) {
      const sym = current && current.sym ? ` [${current.sym}]` : '';
      const what = current && current.indicator ? ` ${current.indicator}` : '';
      logLine(`[STAGE ${stage}${pass ? ' pass ' + pass : ''} start${sym}${what} @${stEl}s${stHeap}]`);
      (onBatch as any)._ls = stageKey;
    } else if (stage === 'robust' && typeof done === 'number' && done % 5 === 0 && (onBatch as any)._lr !== done) {
      (onBatch as any)._lr = done;
      logLine(`[STAGE robust ${done}/${total} @${stEl}s${stHeap}]`);
    }
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
  const stageStats: any = { unionExtra: 0, demoted: 0 };
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
  // Memory guardrail: retained rows are bounded (symbols × topN normally,
  // but a huge topN cap could OOM the tab). Prune to the best 40k by the
  // run objective — logged, never silent.
  if (allRows.length > 40000) {
    const kept = engine.rankResults(allRows, objective).slice(0, 40000);
    logLine(`memory guard: retained ${kept.length}/${allRows.length} rows (best by ${objective})`);
    allRows.length = 0;
    allRows.push(...kept);
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
    const u = engine.researchUnion(allRows, topN, objective);
    top = u.board;
    if (u.extra) logLine(`research union: +${u.extra} rows retained (top-20 per objective beyond top-${topN})`);
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
  // Score config from store (weights + tier cutoffs are user-configurable).
  // Composite post-pass (shared worker + fallback paths): attaches
  // RANKABLE_METRICS (composite/tier/reliability) to every board row.
  try {
    const sst = useStore.getState();
    const cfg: any = {
      weights: sst.scoreW,
      tiers: { insufficient: sst.sampleT.ins, rankable: sst.sampleT.rank },
    };
    for (const r of top) {
      try { r.compositeScore = engine.strategyScore(r.m, cfg); }
      catch { (r as any).compositeScore = null; }
    }
  } catch (e: any) { logLine('composite pass skipped: ' + (e?.message || e)); }
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
    stageStats.demoted = nEdge;
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
  useStore.getState().set({ board: top, lastAllRows: allRows });
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
    logLine(`run done (${runMode}): ${tested} combos in ${secs.toFixed(1)}s [grid ${gridSecs.toFixed(1)}s${s3._refineAt ? ` + refine ${(secs - gridSecs).toFixed(1)}s` : ''}] ${(tested / Math.max(secs, 0.01)).toFixed(0)}/s objective=${objective} errors=${errs}${refineInfo}${wfMsg ? ' · ' + wfMsg : ''}${heapNote()}`);
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
            mcN: mc.iters, mcCapped: mc.capped, mcP5: +mc.p5.toFixed(1), mcMed: +mc.p50.toFixed(1), mcWorst: +mc.worst.toFixed(1),
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
      logLine(`stress[best]: MC${S.mcN}${S.mcCapped ? '(capped)' : ''} maxDD p5=${S.mcP5}% med=${S.mcMed}% worst=${S.mcWorst}% · lossStreak max=${S.maxLossStreak} P4=${(100 * S.p4).toFixed(1)}% P5=${(100 * S.p5).toFixed(1)}% P6=${(100 * S.p6).toFixed(1)}% · avgMAE=${S.avgMAE} avgMFE=${S.avgMFE}`);
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
      // ---- §18 human-readable final report (sections) ----
      logLine('===== RUN IDENTITY =====');
      logLine(`run_id=${useStore.getState().runId || 'unsaved'} engine=v${BUILD_INFO.version} commit=${BUILD_INFO.commit} built=${BUILD_INFO.builtAt} mode=${runMode} objective=${objective}`);
      logLine('===== DATA HEALTH =====');
      dh.verdicts.forEach((v: any) => logLine(`  ${v.ok ? 'PASS' : 'FAIL'} ${v.label} (${v.detail})`));
      logLine('===== SEARCH CONFIG =====');
      logLine(`  sampler=${st.gridMode}${st.gridMode === 'halton' ? `(${st.haltonN})` : ''} bayes=${st.bayesRefine} exits=[${dims.exits.join(',')}] sltp=${st.optRisk ? `${st.slMin}-${st.slMax}/${st.tpMin}-${st.tpMax}` : `${st.slFix}/${st.tpFix}`} cost=${opts.cost}(${opts.costMode}) sig=${opts.sigSource || 'prices'}`);
      logLine('===== DISCOVERY SUMMARY =====');
      {
        const tiers: Record<string, number> = {};
        for (const r of allRows) {
          const t = engine.sampleTier(r.m?.totalTrades || 0, { insufficient: st.sampleT.ins, rankable: st.sampleT.rank });
          tiers[t] = (tiers[t] || 0) + 1;
        }
        logLine(`  tiers: ${Object.entries(tiers).map(([t, n]) => `${t}=${n}`).join(' ')}`);
      }
      logLine('===== RAW OBJECTIVE LEADERS ===== (discovery views — not recommendations)');
      logLine('===== EXPLORATORY LEADERS ===== (10–29 trades, visible, never validated)');
      logLine('===== RANKABLE LEADERS ===== (n≥30 composite selection; NONE if absent)');
      logLine('===== ROBUST LEADERS =====');
      {
        const rb = allRows.filter(r => (r as any).robustScore != null)
          .sort((a, b) => (((b as any).robustScore || 0) - ((a as any).robustScore || 0))).slice(0, 3);
        if (!rb.length) logLine('  BEST_ROBUST = NONE (no robustness evaluated)');
        rb.forEach((r, i) => logLine(`  robust${i + 1}: [${r.symbol || '?'}] ${r.timeframe}m ${r.indicator} score=${((r as any).robustScore || 0).toFixed(2)} n=${r.m.totalTrades}`));
      }
      logLine('===== PARETO FRONTIER ===== (unranked — see PARETO CANDIDATES above)');
      logLine('===== WALK-FORWARD SUMMARY ===== (see WF lines above)');
      logLine('===== ROBUSTNESS SUMMARY ===== (see [FINAL]/classification lines above)');
      logLine('===== SAMPLE-TIER SUMMARY ===== (see DISCOVERY SUMMARY tiers)');
      logLine('===== RANKING DECISIONS ===== (composite selection over rankable rows; raw views preserved; demotion logged; RANKING_INTEGRITY above)');
      logLine('===== WHY CANDIDATES WERE EXCLUDED ===== (see WHY_NOT_RANKED + THIN-SAMPLE + PAPER verdict lines)');
      logLine('===== OFFLINE AUDIT ARTIFACTS ===== (use ⤓ Export audit JSON in the dev panel)');
      logLine('===== HASHES ===== (dataset/config/results hashes inside the exported artifact)');
      logLine('===== FINAL VERDICT =====');
      logLine('  BEST AVAILABLE SAMPLE RESULT ≠ VALIDATED GENERAL STRATEGY. Research discovery only.');
    } catch (e: any) { logLine('research audit skipped: ' + (e?.message || e)); }
    buildProfiles(bd, symData, opts, mySeq);
    logLine('===== END SUMMARY =====');
  } catch (e: any) { logLine('summary build failed: ' + (e?.message || e)); }
  setRun({ current: '' });
  const s4 = useStore.getState();
  if (bd.length && !s4.userPickedSeq) selectRow(bd[0], true);
  // PAPER verdict for the champion (logged every run, regardless of adaptive).
  if (bd.length && !stopped) {
    const gate = engine.paperEligible(bd[0], { scoreThreshold: s4.paperThreshold ?? 9.5, cost: opts.cost, allowZeroCost: opts.costMode === 'signal', minTrades: s4.paperMinTrades ?? 200 });
    useStore.getState().set({ lastPaper: gate });
    if (gate.eligible) logLine(`PAPER: ELIGIBLE — [${bd[0].symbol}] ${bd[0].timeframe}m ${bd[0].indicator} passed all gates${(gate.warnings || []).length ? ' (warnings: ' + (gate.warnings || []).join('; ') + ')' : ''}`);
    else logLine(`PAPER: BLOCKED — ${gate.reasons.join(' · ')}`);
    logSelection(bd, opts);
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

// Selection report: BEST_RANKABLE_COMPOSITE (or NONE), THIN-sample list,
// PARETO frontier (unranked ids), RANKING WARNINGS, WHY_RANKED lines.
// Pure discovery + honest labels — never hides rows, never manufactures.
export function logSelection(bd: BoardRow[], opts: any) {
  try {
    // RANKABLE = tier RANKABLE only (n ≥ configured threshold). EXPLORATORY
    // rows are NEVER promoted — they get their own BEST_EXPLORATORY line.
    const ranked = bd.filter(r => r.compositeScore && r.compositeScore.tier === 'RANKABLE')
      .sort((a, b) => ((b.compositeScore || {}).composite || 0) - ((a.compositeScore || {}).composite || 0));
    const best = ranked[0] || null;
    if (best && best.compositeScore) {
      const c = best.compositeScore;
      logLine(`BEST_RANKABLE_COMPOSITE: [${best.symbol || '?'}] ${best.timeframe}m ${best.indicator} ${fmtParams(best.params)} score=${c.composite} tier=${c.tier} n=${c.n} pnl=${Math.round(best.m.netPnL)} wr=${best.m.winRate.toFixed(1)}% exp=${best.m.expectancy.toFixed(2)} pf=${best.m.profitFactor.toFixed(2)} sharpe=${best.m.sharpe.toFixed(2)}(adj ${c.sharpeAdj}) dd=${best.m.maxDD.toFixed(2)}%`);
      const p = c.parts || {};
      logLine(`  RANKING_BREAKDOWN: return=${p.ret} winExp=${p.winExp} pf=${p.pf} sample=${p.sample} risk=${p.risk} sharpe=${p.sharpe} → COMPOSITE=${c.composite}`);
      logLine(`  WHY_RANKED: largest composite among ${ranked.length} rankable rows (n≥${useStore.getState().sampleT.rank}, reliability=${c.reliability})`);
    } else {
      logLine('BEST_RANKABLE_COMPOSITE = NONE (no RANKABLE rows — REASON=NO_CANDIDATE_MEETS_SAMPLE_THRESHOLD; see RAW discovery)');
    }
    // TOP_MEANINGFUL (n≥10: exploratory + rankable — surfaces FVG/Bollinger/
    // VWAP-type rows with reasonable counts even when below rankable cutoff).
    // BEST_ROBUST (top robustScore among robust-eligible rows).
    try {
      const meanRows = bd.filter(r => (r.m?.totalTrades || 0) >= 10 && r.compositeScore)
        .sort((a, b) => ((b.compositeScore || {}).composite || 0) - ((a.compositeScore || {}).composite || 0));
      const mb = meanRows[0] || null;
      if (mb && mb.compositeScore) logLine(`TOP_MEANINGFUL_SAMPLE: [${mb.symbol || '?'}] ${mb.timeframe}m ${mb.indicator} score=${mb.compositeScore.composite} tier=${mb.compositeScore.tier} n=${mb.m.totalTrades} wr=${mb.m.winRate.toFixed(1)}% pnl=${Math.round(mb.m.netPnL)}`);
      else logLine('TOP_MEANINGFUL_SAMPLE = NONE (n<10 everywhere)');
      const rbRows = bd.filter(r => (r as any).robustScore != null)
        .sort((a, b) => (((b as any).robustScore || 0) - ((a as any).robustScore || 0)));
      const rbBest = rbRows[0] || null;
      if (rbBest) logLine(`BEST_ROBUST: [${rbBest.symbol || '?'}] ${rbBest.timeframe}m ${rbBest.indicator} score=${(((rbBest as any).robustScore || 0)).toFixed(2)} n=${rbBest.m.totalTrades} classification=${((rbBest as any).robustness || {}).classification || '?'}`);
      else logLine('BEST_ROBUST = NONE (no robustness evaluated)');
      const oosRows = bd.filter(r => (r as any).survived === true && (r as any).oosNet != null)
        .sort((a, b) => (((b as any).oosNet || 0) - ((a as any).oosNet || 0)));
      const oosBest = oosRows[0] || null;
      if (oosBest) logLine(`BEST_OOS: [${oosBest.symbol || '?'}] ${oosBest.timeframe}m ${oosBest.indicator} oosNet=${Math.round((oosBest as any).oosNet)} oosWR=${(((oosBest as any).oosWR || 0)).toFixed(1)}% oosN=${(oosBest as any).oosN} IS_WR=${oosBest.m.winRate.toFixed(1)}%`);
      else logLine('BEST_OOS = NONE (no OOS survivor)');
      const stPE = useStore.getState();
      const peRows = bd.filter(r => {
        const g = engine.paperEligible(r, { scoreThreshold: stPE.paperThreshold ?? 9.5, cost: opts.cost, allowZeroCost: opts.costMode === 'signal', minTrades: stPE.paperMinTrades ?? 200 });
        return g.eligible;
      }).sort((a, b) => ((b.compositeScore || {}).composite || 0) - ((a.compositeScore || {}).composite || 0));
      const peBest = peRows[0] || null;
      if (peBest) logLine(`BEST_PAPER_ELIGIBLE: [${peBest.symbol || '?'}] ${peBest.timeframe}m ${peBest.indicator} score=${((peBest.compositeScore || {}).composite ?? '?')} n=${peBest.m.totalTrades}`);
      else logLine('BEST_PAPER_ELIGIBLE = NONE (no candidate cleared every gate — see PAPER verdict)');
    } catch (e: any) { logLine('meaningful/robust lines skipped: ' + (e?.message || e)); }
    const expl = bd.filter(r => r.compositeScore && r.compositeScore.tier === 'EXPLORATORY')
      .sort((a, b) => ((b.compositeScore || {}).composite || 0) - ((a.compositeScore || {}).composite || 0))[0] || null;
    if (expl && expl.compositeScore) {
      const c = expl.compositeScore;
      logLine(`BEST_EXPLORATORY_COMPOSITE: [${expl.symbol || '?'}] ${expl.timeframe}m ${expl.indicator} ${fmtParams(expl.params)} score=${c.composite} n=${c.n} pnl=${Math.round(expl.m.netPnL)} wr=${expl.m.winRate.toFixed(1)}% (NOT rankable — exploratory only)`);
    } else {
      logLine('BEST_EXPLORATORY_COMPOSITE = NONE');
    }
    const thin = bd.filter(r => !r.compositeScore || r.compositeScore.tier === 'INSUFFICIENT').slice(0, 8);
    if (thin.length) {
      logLine(`THIN-SAMPLE CANDIDATES (${thin.length} shown, visible NOT validated):`);
      thin.forEach((r, i) => logLine(`  thin${i + 1}: [${r.symbol || '?'}] ${r.timeframe}m ${r.indicator} n=${r.m.totalTrades} wr=${r.m.winRate.toFixed(1)}% pnl=${Math.round(r.m.netPnL)} sharpe=${r.m.sharpe.toFixed(1)} THIN SAMPLE / NOT RANKABLE`));
    }
    const pareto = engine.paretoFrontier(bd.filter(r => r.m && r.m.totalTrades >= 10));
    if (pareto.length) logLine(`PARETO CANDIDATES (${pareto.length}, unranked, n≥10): ` + pareto.slice(0, 12).map(r => `[${r.symbol || '?'}]${r.timeframe}m ${r.indicator} n=${r.m.totalTrades}`).join(' · '));
    const warns: string[] = [];
    bd.slice(0, 25).forEach(r => {
      const n = r.m?.totalTrades || 0;
      if (n > 0 && n < 30 && Math.abs(r.m?.sharpe || 0) > 20) warns.push(`SHARPE_ANNUALIZATION_WARNING: [${r.symbol || '?'}] ${r.indicator} Sharpe=${(r.m.sharpe || 0).toFixed(1)} on n=${n} (reliability LOW — ranking uses adj)`);
      if (r.robustness && r.robustness.blockBootstrap && !r.robustness.blockBootstrap.nSamples) warns.push(`BOOTSTRAP_STATUS=SKIPPED for [${r.symbol || '?'}] ${r.indicator} (insufficient sample — never a [0,0] interval)`);
    });
    if (warns.length) { logLine('RANKING WARNINGS:'); warns.slice(0, 8).forEach(w => logLine('  ' + w)); }
    if (best && best.compositeScore) {
      const c = best.compositeScore;
      const whyNot: string[] = [];
      if (c.tier === 'INSUFFICIENT') whyNot.push(`n=${c.n} below rankable threshold`);
      if (c.reliability !== 'HIGH') whyNot.push(`Sharpe reliability ${c.reliability}`);
      logLine(whyNot.length ? `WHY_NOT_RANKED: ${whyNot.join('; ')}` : 'WHY_NOT_RANKED: n/a (champion is rankable)');
    }
  } catch (e: any) { logLine('selection report skipped: ' + (e?.message || e)); }
}

// ---------- Offline audit artifact (§6–9, §15–17) ----------
// One JSON artifact per run: manifest, config, data, candidates, ranking,
// robustness, walk-forward, trades, stages, final report + hashes. The browser
// cannot write directories, so the spec's logs/research_runs/<id>/ layout is
// delivered as a single research_<run_id>.json download with identical
// sections. Trade records attach at EXPORT time (top-50 rebuild); everything
// else is stashed at run end. No silent deletion anywhere.
async function sha256hex(s: string): Promise<{ algo: string; hash: string }> {
  try {
    const subtle = (globalThis.crypto || {}).subtle;
    if (subtle) {
      const d = await subtle.digest('SHA-256', new TextEncoder().encode(s));
      return { algo: 'SHA-256', hash: [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') };
    }
  } catch { /* fall through to FNV */ }
  return { algo: 'FNV-1a-32', hash: engine.hashRecord(s) };
}

function slimRobustness(rb: any): any {
  // Full evidence dump minus unbounded arrays (neighborMetrics capped) —
  // documented truncation, counts preserved.
  if (!rb || typeof rb !== 'object') return rb;
  const out: any = Array.isArray(rb) ? [] : {};
  for (const k of Object.keys(rb)) {
    const v = (rb as any)[k];
    if (Array.isArray(v) && v.length > 50) out[k] = { truncated: true, kept: 50, total: v.length, sample: v.slice(0, 50) };
    else if (v && typeof v === 'object' && !(v instanceof Float64Array) && !(v instanceof Int8Array)) out[k] = slimRobustness(v);
    else if (v instanceof Float64Array || v instanceof Int8Array) out[k] = { typedArray: true, length: v.length };
    else out[k] = v;
  }
  return out;
}

function candidateRecord(r: BoardRow, rank: number | null, totalCombos: number, runCtx: any): any {
  const m: any = r.m || {};
  // Sanitize non-finite metric values (±Infinity Sharpe) to ±1e9 BEFORE
  // everything: JSON cannot represent Infinity (→null), which would break
  // offline replay determinism. Documented, deterministic, applied once.
  const clean: any = {};
  for (const k of Object.keys(m)) {
    const v = (m as any)[k];
    clean[k] = (typeof v === 'number' && !isFinite(v)) ? (v > 0 ? 1e9 : -1e9) : v;
  }
  const n = clean.totalTrades || 0;
  const wins = Math.round((clean.winRate || 0) * n / 100);
  const comp = (r as any).compositeScore || engine.strategyScore(clean, runCtx.scoreCfg);
  const gross = clean.grossPreCost ?? (clean.netPnL + (clean.totalCosts || 0));
  return {
    candidate_id: engine.cfgKey(r as any),
    display_id: candidateId(r),
    row_index: (r as any).i ?? null,
    instrument: r.symbol || '', symbol: r.symbol || '',
    expiry: runCtx.expiries[r.symbol || ''] || null,
    timeframe: r.timeframe, indicator: r.indicator, indicator_parameters: r.params,
    strategy_family: (((engine as any).FAMILY || {})[r.indicator] || '?'),
    direction: runCtx.direction, entry_mode: runCtx.entry, fill_model: runCtx.fill,
    regime: runCtx.regime, regime_parameters: runCtx.regimeParams,
    exit_model: r.exit || 'fixed', SL: r.slPct, TP: r.tpPct, trail: r.trailPct, carry: !!r.carry,
    cost_mode: runCtx.costMode, parameters_locked: true, reoptimized: !!r.refined ? 'hill-climb-refine' : false,
    trade_count: n, wins, losses: n - wins, WR: clean.winRate, gross_pnl: gross, net_pnl: clean.netPnL,
    expectancy: clean.expectancy, profit_factor: clean.profitFactor,
    metrics: clean,
    payoff_ratio: (clean.grossLoss > 0 && wins > 0 && (n - wins) > 0) ? +((clean.grossProfit / wins) / (clean.grossLoss / (n - wins))).toFixed(4) : null,
    Sharpe: clean.sharpe, Sortino: clean.sortino, maxDD: clean.maxDD,
    avgDD: null, largest_winner: null, largest_loser: null,
    avg_MAE: null, median_MAE: null, avg_MFE: null, median_MFE: null, MFE_MAE_ratio: null,
    extended_from: (r as any).robustness && (r as any).robustness.baseline ? 'robustness-baseline' : null,
    sample_tier: comp.tier, rankable: comp.tier === 'RANKABLE',
    composite_score: comp.composite, composite_parts: comp.parts,
    sharpe_raw: comp.sharpeRaw, sharpe_adjusted: comp.sharpeAdj, sharpe_reliability: comp.reliability,
    robust_score: (r as any).robustScore ?? null,
    robust_classification: (r as any).robustness?.classification ?? null,
    oos: { net: (r as any).oosNet ?? null, wr: (r as any).oosWR ?? null, n: (r as any).oosN ?? null, survived: (r as any).survived ?? null, folds: (r as any).oosFolds ?? null },
    why_not_ranked: engine.whyNotRanked(r as any, { tiers: runCtx.tiers }),
    rank, search_percentile: totalCombos && rank ? +((1 - rank / totalCombos) * 100).toFixed(2) : 0,
  };
}

export function buildAuditArtifact(): any {
  const st = useStore.getState();
  const allRows: BoardRow[] = st.lastAllRows?.length ? st.lastAllRows : st.board;
  const L = st.lastRun || {};
  const scoreCfgW = {
    weights: st.scoreW,
    tiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank },
  };
  // ---- data manifest ----
  const ds = st.datasets;
  const symbols = Object.keys(ds);
  const perSymbol = symbols.map(k => {
    const d = ds[k].raw;
    const step = Math.max(1, Math.floor(d.t.length / 20000));
    const days = new Set<string>();
    for (let i = 0; i < d.t.length; i += step) days.add(engine.istDayKey(d.t[i]));
    const c = (d as any).contract || {};
    return {
      symbol: k, label: ds[k].label, bars: d.t.length,
      sessions: days.size,
      first_timestamp: d.t.length ? new Date(d.t[0]).toISOString() : null,
      last_timestamp: d.t.length ? new Date(d.t[d.t.length - 1]).toISOString() : null,
      contract: c.strike != null ? c : null,
      filtered_bars: 0, missing_sessions: 'not-tracked (parser drops bad rows silently — see caution)',
      duplicate_bars: 'not-tracked', bad_bars: 'dropped-at-parse-uncounted',
    };
  });
  const totalBars = perSymbol.reduce((a, s) => a + s.bars, 0);
  const expiries = [...new Set(perSymbol.map(s => s.contract?.expiry).filter(Boolean))];
  const datasetHash = engine.hashRecord(symbols.map(k => `${k}:${ds[k].raw.t.length}:${ds[k].raw.t[0] ?? 0}:${ds[k].raw.t[ds[k].raw.t.length - 1] ?? 0}`).join('|'));
  const dataManifest = {
    source_files: perSymbol.map(s => s.label), symbols,
    contracts: perSymbol.filter(s => s.contract).length,
    expiry_dates: expiries,
    session_count: perSymbol.reduce((a, s) => a + s.sessions, 0),
    bars_per_symbol: Object.fromEntries(perSymbol.map(s => [s.symbol, s.bars])),
    total_bars: totalBars,
    timeframe: '1m source (resampled per-TF at evaluation)',
    timezone: 'Asia/Kolkata(pinned)',
    per_symbol: perSymbol,
    RAW_DATA_SESSIONS: perSymbol.reduce((a, s) => a + s.sessions, 0),
    SELECTED_CONTRACT_SESSIONS: 'see per_symbol.sessions (enabled toggles not snapshotted — see limitation)',
    ALIGNED_RESEARCH_SESSIONS: 'per-TF inner alignment in underlying-led mode; else native bars',
    USABLE_TRADING_SESSIONS: 'in-session bars per exchange mask (see run log data-health)',
    alignment_rules: 'option bars never filled; underlying legs last-known-causal; resample O/H/L/C/V aggregates only',
    selected_contract_rules: 'largest-enabled default | ATM±N union | manual ticks (see session log)',
    dataset_hash: datasetHash, dataset_hash_algo: 'FNV-1a-32 (structural: symbol+bars+endpoints)',
  };
  // ---- config ----
  const tradeOptsNow: any = {};
  try { Object.assign(tradeOptsNow, tradeOpts()); } catch { /* pre-run */ }
  delete tradeOptsNow.sessionMask; delete tradeOptsNow.tradeMask;
  const config = {
    objective: st.objective, direction: tradeOptsNow.direction, entry_mode: tradeOptsNow.entry,
    fill_model: tradeOptsNow.fill, session_filter: [tradeOptsNow.sessionStart, tradeOptsNow.sessionEnd],
    regime: tradeOptsNow.regimeOn ? `${tradeOptsNow.regimeSource}/${tradeOptsNow.granularity}` : 'off',
    confidence_gate: tradeOptsNow.confGate, walk_forward_config: { on: st.wfOn, split: st.wfSplit, purge: st.purgeBars, embargo: st.embargoBars },
    sampler: st.gridMode, sampler_seed: st.gridMode === 'halton' ? 'none (deterministic Halton)' : 'n/a (cartesian)',
    halton_N: st.haltonN, bayesian_enabled: st.bayesRefine, top_N: st.topN, candidate_cap: st.cap,
    board_min_trades: st.minTradesBoard, cost_mode: st.costMode, cost_per_trade: tradeOptsNow.cost,
    sl_values: st.optRisk ? [st.slMin, st.slMax, st.slStep] : [st.slFix],
    tp_values: st.optRisk ? [st.tpMin, st.tpMax, st.tpStep] : [st.tpFix],
    trail_values: st.trail, exit_models: st.exits, carry_models: st.sessMode,
    indicator_set: Object.entries(st.inds).filter(([, v]: any) => v.on).map(([k]) => k),
    strategy_families: 'single-indicator + PAIR stage-2 + presets (SqueezeBreak/VWAPRev/TrendRegime/TrendFollow/VWAPMR)',
    scoreW: st.scoreW, sampleTiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank }, paperThreshold: st.paperThreshold, paperMinTrades: st.paperMinTrades,
    parameters_locked: true, reoptimized: 'hill-climb + Bayes are search-time (logged); robustness never re-optimizes',
  };
  const runCtx = {
    direction: config.direction, entry: config.entry_mode, fill: config.fill_model,
    regime: config.regime, regimeParams: { source: tradeOptsNow.regimeSource, granularity: tradeOptsNow.granularity },
    costMode: config.cost_mode, scoreCfg: { weights: config.scoreW, tiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank } },
    expiries: Object.fromEntries(perSymbol.filter(s => s.contract).map(s => [s.symbol, s.contract.expiry])),
    tiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank },
  };
  // ---- run manifest ----
  const manifest = {
    run_id: st.runId || 'unsaved',
    run_start: L.at || null, run_end: new Date().toISOString(),
    duration_ms: L.secs != null ? Math.round(L.secs * 1000) : null,
    engine_version: BUILD_INFO, git_commit: BUILD_INFO.commit, build_version: BUILD_INFO.version,
    worker_or_main_thread: L.mode || null,
    browser_runtime: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : 'node',
    os_runtime: typeof navigator !== 'undefined' ? (navigator as any).platform || 'unknown' : 'node',
    timezone: 'Asia/Kolkata(pinned)', exchange: tradeOptsNow.exchange, market_hours: [tradeOptsNow.sessionStart, tradeOptsNow.sessionEnd],
    mode: 'research', instrument_mode: st.instrumentMode || 'futures',
    objective: config.objective, direction: config.direction, entry_mode: config.entry_mode,
    fill_model: config.fill_model, session_filter: config.session_filter, regime: config.regime,
    confidence_gate: config.confidence_gate, walk_forward_config: config.walk_forward_config,
    purge: st.purgeBars, embargo: st.embargoBars, sampler: config.sampler, sampler_seed: config.sampler_seed,
    halton_N: config.halton_N, bayesian_enabled: config.bayesian_enabled, top_N: config.top_N,
    candidate_cap: config.candidate_cap, board_min_trades: config.board_min_trades,
    cost_mode: config.cost_mode, cost_per_trade: config.cost_per_trade,
    sl_values: config.sl_values, tp_values: config.tp_values, trail_values: config.trail_values,
    exit_models: config.exit_models, carry_models: config.carry_models,
    indicator_set: config.indicator_set, strategy_families: config.strategy_families,
    parameters_locked: true, reoptimized: config.reoptimized,
  };
  // ---- candidates (ALL evaluated rows) ----
  const totalCombos = allRows.length;
  const rankedAll = engine.rankResults(allRows, st.objective);
  const rankOf = new Map<string, number>();
  rankedAll.forEach((r, i) => { const k = engine.cfgKey(r as any); if (!rankOf.has(k)) rankOf.set(k, i + 1); });
  const candidate_results = allRows.map(r => {
    const rec = candidateRecord(r, rankOf.get(engine.cfgKey(r as any)) ?? null, totalCombos, runCtx);
    rec._row_hash = engine.hashRecord([rec.candidate_id, rec.net_pnl, rec.trade_count]);
    return rec;
  });
  // ---- ranking stages ----
  const per_objective: Record<string, string[]> = {};
  for (const [key] of (engine.RESEARCH_OBJS as [string, string][])) {
    per_objective[key] = [...allRows].sort(engine.researchCmp(key)).slice(0, 20).map(r => engine.cfgKey(r as any));
  }
  const paretoIds = engine.paretoFrontier(allRows.filter(r => r.m && r.m.totalTrades > 0)).map(r => engine.cfgKey(r as any));
  // WHY_DOMINATED: first frontier dominator per non-member (default 7 dims).
  const pareto_results = (() => {
    try {
      const dims: [string, number][] = [['netPnL', 1], ['expectancy', 1], ['winRate', 1], ['totalTrades', 1], ['profitFactor', 1], ['maxDD', 1], ['sharpe', 1]];
      const val = (r: any, k: string) => { const v = r.m && r.m[k]; return (typeof v === 'number' && isFinite(v)) ? v : -Infinity; };
      const domBy = (a: any, b: any) => { let s = false; for (const [k, dir] of dims) { const d = (val(a, k) - val(b, k)) * dir; if (d < 0) return false; if (d > 0) s = true; } return s; };
      const front = new Set(paretoIds);
      const byKey = new Map(allRows.map(r => [engine.cfgKey(r as any), r]));
      const members = paretoIds.map(k => byKey.get(k)).filter(Boolean);
      const why: Record<string, string> = {};
      for (const r of allRows.slice(0, 500)) {
        const k = engine.cfgKey(r as any);
        if (front.has(k)) continue;
        const d = members.find(m => m && domBy(m, r));
        if (d) why[k] = 'PARETO_DOMINATED by ' + engine.cfgKey(d as any).slice(0, 80);
      }
      return { dims: dims.map(([k, d]) => `${d > 0 ? 'max' : 'min'}_${k}`), pareto: paretoIds, dominated_sample: why };
    } catch { return { dims: [], pareto: paretoIds, dominated_sample: {} }; }
  })();
  const ranking_results = {
    input_count: allRows.length,
    stages: [
      { STAGE_NAME: 'DISCOVERY_GRID', INPUT_COUNT: totalCombos, OUTPUT_COUNT: totalCombos, SORT_RULE: 'none (evaluation order)', FILTER_RULE: 'none', FILTER_PARAMETERS: {}, NORMALIZATION_RULE: 'none', SEED: config.sampler_seed },
      { STAGE_NAME: 'REFINE_HILLCLIMB_BAYES', INPUT_COUNT: totalCombos, OUTPUT_COUNT: (L.refined || 0), SORT_RULE: 'objective-improvement', FILTER_RULE: 'untested-neighbors-only', FILTER_PARAMETERS: {}, NORMALIZATION_RULE: 'none', SEED: 'deterministic Halton proposals' },
      { STAGE_NAME: 'RESEARCH_UNION', INPUT_COUNT: allRows.length, OUTPUT_COUNT: st.board.length, SORT_RULE: 'configured-objective + top-20/objective union', FILTER_RULE: 'topN + research-union', FILTER_PARAMETERS: { topN: config.top_N }, NORMALIZATION_RULE: 'none', SEED: 'n/a' },
      { STAGE_NAME: 'COMPOSITE_RANK', INPUT_COUNT: st.board.length, OUTPUT_COUNT: st.board.length, SORT_RULE: 'composite desc, rankable-first', FILTER_RULE: 'none (thin retained)', FILTER_PARAMETERS: { weights: config.scoreW, tiers: config.sampleTiers }, NORMALIZATION_RULE: 'absolute bounded transforms (see strategyScore)', SEED: 'n/a' },
    ],
    per_objective, pareto: paretoIds,
    audit: [],
    board_order: st.board.map(r => engine.cfgKey(r as any)),
  };
  // ---- robustness / walk-forward summaries ----
  const robustRows = allRows.filter(r => (r as any).robustness);
  const robustness_results = robustRows.map(r => {
    const rb: any = (r as any).robustness;
    return {
      candidate_id: engine.cfgKey(r as any),
      parameter_stability: rb.paramStability ? { neighbors: rb.paramStability.neighbors, density: rb.paramStability.density, medianSharpe: rb.paramStability.medianSharpe } : null,
      exit_independence: rb.exitIndependence ? { variants: rb.exitIndependence.variants, profitable: rb.exitIndependence.profitable } : null,
      signal_purity: rb.signalPurity ? { ratio: rb.signalPurity.ratio } : null,
      regime_robustness: rb.regimeRobustness ? { profitableRegimes: rb.regimeRobustness.profitableRegimes } : null,
      time_robustness: rb.timeRobustness ? { profitableWindows: rb.timeRobustness.profitableWindows } : null,
      entry_perturbation: rb.entryPerturbation ? { profitable: rb.entryPerturbation.profitable } : null,
      input_perturbation: rb.inputPerturbation ? { profitable: rb.inputPerturbation.profitable } : null,
      'P&L_concentration': rb.concentration ? { top1: rb.concentration.top1Pct, top5: rb.concentration.top5Pct } : null,
      best_trade_removal: rb.worstTradeRemoval ? { remove1: rb.worstTradeRemoval.remove1, remove10: rb.worstTradeRemoval.remove10 } : null,
      parameter_sensitivity: rb.paramSensitivity ? { pss: rb.paramSensitivity.pss, knifeEdge: rb.paramSensitivity.knifeEdge, skipped: !!rb.paramSensitivity.skipped } : { STATUS: 'SKIPPED', REASON: 'not evaluated' },
      bootstrap: rb.blockBootstrap ? (rb.blockBootstrap.nSamples ? { status: 'OK', method: rb.blockBootstrap.method, iterations: rb.blockBootstrap.iters, block: rb.blockBootstrap.block, seed: rb.blockBootstrap.seed, n: rb.blockBootstrap.n, sharpe_CI: rb.blockBootstrap.sharpe, WR_CI: rb.blockBootstrap.wr, PF_CI: rb.blockBootstrap.pf } : { status: 'SKIPPED', reason: rb.blockBootstrap.reason || 'INSUFFICIENT_SAMPLE', sharpe_CI: null, WR_CI: null, PF_CI: null }) : { STATUS: 'SKIPPED', REASON: 'not evaluated' },
      surrogate: rb.surrogate ? { p: rb.surrogate.p, n: rb.surrogate.nSurr, skipped: !!rb.surrogate.skipped } : { STATUS: 'SKIPPED', REASON: 'not evaluated' },
      PSS: rb.paramSensitivity ? rb.paramSensitivity.pss : null,
      multiple_testing: rb.final ? { penalty: rb.final.penalty, cap: rb.final.cap } : null,
      free_parameter_count: rb.freeParams ?? null,
      final_raw_score: rb.final?.raw ?? null, final_adjusted_score: rb.final?.adjusted ?? null,
      classification: rb.classification ?? null,
      adjusted: (r as any).robustScore ?? null,
    };
  });
  const wfRows = allRows.filter(r => (r as any).oosFolds || (r as any).oosN != null);
  const walkforward_results = {
    config: config.walk_forward_config,
    TOTAL_WF_CANDIDATES: wfRows.length,
    SURVIVED_WF: wfRows.filter(r => (r as any).survived).length,
    FAILED_WF: wfRows.filter(r => (r as any).survived === false).length,
    SKIPPED_WF: wfRows.filter(r => (r as any).survived == null).length,
    rows: wfRows.slice(0, 200).map(r => ({
      candidate_id: engine.cfgKey(r as any),
      train_period: 'IS slice (see data_manifest span + wf split)',
      test_period: 'OOS tail (see data_manifest span + wf split)',
      folds: (((r as any).oosFolds || []) as any[]).map((f: any, i: number) => ({
        fold_id: i, test_n: f.n, test_pnl: +f.net.toFixed(2), test_WR: +f.wr.toFixed(2), test_sharpe: f.sharpe == null ? null : +f.sharpe.toFixed(2),
        skipped: !!f.skipped, survived: !f.skipped && f.net > 0,
        failure_reason: f.skipped ? 'THIN_FOLD' : (f.net > 0 ? '' : 'NEGATIVE_FOLD_PNL'),
      })),
      train_n: r.m.totalTrades, test_n: (r as any).oosN ?? null,
      train_pnl: +r.m.netPnL.toFixed(2), test_pnl: (r as any).oosNet ?? null,
      train_WR: +r.m.winRate.toFixed(2), test_WR: (r as any).oosWR ?? null,
      train_expectancy: +r.m.expectancy.toFixed(4), test_expectancy: null,
      train_PF: +r.m.profitFactor.toFixed(2), test_PF: null,
      train_Sharpe: +r.m.sharpe.toFixed(2), test_Sharpe: null,
      survived: !!(r as any).survived,
      failure_reason: (r as any).survived ? '' : ((r as any).survived === false ? 'OOS_FOLDS_NEGATIVE' : 'NO_FOLD_VERDICT'),
    })),
  };
  // ---- final report (§18 sections as data) ----
  const byComp = (rows: any[]) => rows.map(rr => ({ r: rr, s: engine.strategyScore(rr.m, { weights: config.scoreW, tiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank } }) })).sort((a, b) => b.s.composite - a.s.composite)[0] || null;
  const rkBest = byComp(allRows.filter(rr => engine.rankableScore(rr.m, { weights: config.scoreW, tiers: { insufficient: st.sampleT.ins, rankable: st.sampleT.rank } }) !== null));
  const exBest = byComp(allRows.filter(rr => engine.sampleTier(rr.m?.totalTrades || 0, { insufficient: st.sampleT.ins, rankable: st.sampleT.rank }) === 'EXPLORATORY'));
  const rbBest = robustRows.slice().sort((a, b) => (((b as any).robustScore || 0) - ((a as any).robustScore || 0)))[0] || null;
  const tierCounts: Record<string, number> = {};
  for (const rr of allRows) { const t = engine.sampleTier(rr.m?.totalTrades || 0, { insufficient: st.sampleT.ins, rankable: st.sampleT.rank }); tierCounts[t] = (tierCounts[t] || 0) + 1; }
  const bestBy: Record<string, string | null> = {};
  for (const [key] of (engine.RESEARCH_OBJS as [string, string][])) {
    const br = [...allRows].sort(engine.researchCmp(key))[0];
    bestBy[key] = br ? engine.cfgKey(br as any) : null;
  }
  const final_report = {
    RAW_DISCOVERY: { count: allRows.length },
    BEST_RAW: bestBy,
    BEST_EXPLORATORY: exBest ? engine.cfgKey(exBest.r as any) : 'NONE',
    BEST_RANKABLE: rkBest ? engine.cfgKey(rkBest.r as any) : 'NONE',
    BEST_ROBUST: rbBest ? engine.cfgKey(rbBest as any) : 'NONE',
    PARETO_COUNT: paretoIds.length,
    WF: { survived: walkforward_results.SURVIVED_WF, failed: walkforward_results.FAILED_WF, skipped: walkforward_results.SKIPPED_WF },
    SAMPLE_TIERS: tierCounts,
    RANKING_DECISIONS: 'composite selection over rankable rows; raw views preserved; demotion logged',
    EXCLUSIONS: 'see candidate why_not_ranked fields',
    VERDICT: useStore.getState().lastPaper,
  };
  const art: any = {
    format: 'xbost-research-audit/1',
    run_manifest: manifest, config, data_manifest: dataManifest,
    candidate_results, ranking_results, robustness_results, walkforward_results,
    trade_records: [], trade_records_note: withTradesNote(),
    time_profile_results: useStore.getState().lastProfiles || [],
    transfer_results: useStore.getState().lastTransfer || [],
    profile: (useStore.getState().lastProfiles || []).map((p: any) => ({
      profile_id: p.profile_id, market: p.market, instrument: p.instrument,
      timeframe: p.timeframe, data_start: p.data_start, data_end: p.data_end,
      generated_at: p.generated_at, engine_version: p.engine_version,
      engine_hash: p.engine_hash, data_hash: p.data_hash, strategy_hash: p.strategy_hash,
      sampler_seed: p.sampler_seed, validation_status: p.validation_status,
      parameters_locked: p.parameters_locked, reoptimized: p.reoptimized,
      eligible: p.eligible, merged: p.merged,
    })),
    pareto_results,
    stage_summary: ranking_results.stages, final_report,
    hash_manifest: {},
    hashes: {
      dataset: { algo: 'FNV-1a-32', hash: dataManifest.dataset_hash },
      config: { algo: 'FNV-1a-32', hash: engine.hashRecord(config) },
      results: { algo: 'FNV-1a-32', hash: engine.hashRecord(candidate_results.map(c => [c.candidate_id, c.net_pnl, c.trade_count])) },
      engine: { version: BUILD_INFO.version, commit: BUILD_INFO.commit, builtAt: BUILD_INFO.builtAt, note: 'version stamp (source hash unavailable in browser)' },
      artifact: null as any,
    },
  };
  art.hash_manifest = Object.fromEntries(Object.entries(art.hashes).filter(([k]) => k !== 'artifact').map(([k, v]: any) => [k + '.json', v]));
  useStore.getState().set({ lastAudit: art });
  logLine(`audit artifact staged (${allRows.length} candidates, ${dataManifest.total_bars} bars) — use ⤓ Export audit JSON to download with trade records + hashes`);
  return art;
}
function withTradesNote() {
  return 'trade_records attach at EXPORT (top-50 board rows rebuilt). Timestamp convention: entry/exit timestamps are FILL bars (signal-bar close when fill=close, next-bar open when fill=next); lat flag marks next-bar latency. Regime per trade: null (per-strategy CSV export carries regime columns).';
}

export async function downloadAuditArtifact() {
  const st = useStore.getState();
  if (!st.lastAllRows?.length && !st.board.length) { st.set({ alert: 'Nothing to export — run a grid search first.' }); return; }
  logLine('audit export: rebuilding top-50 trade records…');
  const art = buildAuditArtifact();
  try {
    const rows = (st.board || []).slice(0, 50);
    for (const r of rows) {
      try {
        const det = detailFor(r);
        if (!det) continue;
        for (const t of det.bt.trades) {
          const ip = engine.istParts(t.entryTime);
          art.trade_records.push({
            candidate_id: engine.cfgKey(r as any),
            trade_id: t.id, symbol: r.symbol || '',
            timestamp_signal: new Date(t.entryTime).toISOString(), timestamp_entry: new Date(t.entryTime).toISOString(), timestamp_exit: new Date(t.exitTime).toISOString(),
            direction: t.type, entry_price: t.entryPx, exit_price: t.exitPx,
            SL: r.slPct, TP: r.tpPct, exit_reason: t.reason,
            gross_pnl: +(t.pnl + (st.costMode === 'signal' ? 0 : st.cost)).toFixed(2), net_pnl: +t.pnl.toFixed(2),
            MAE: (t as any).mae ?? null, MFE: (t as any).mfe ?? null,
            holding_bars: t.exitIdx - t.entryIdx,
            session_date: `${ip.y}-${ip.mo}-${ip.day}`, time_bucket: `${String(ip.h).padStart(2, '0')}:${String(ip.m).padStart(2, '0')}`,
            regime: null, regime_note: 'see per-strategy trades CSV export for regime columns',
          });
        }
      } catch { /* per-row best effort */ }
      await new Promise(rr => setTimeout(rr, 0));
    }
  } catch (e: any) { logLine('trade rebuild partial: ' + (e?.message || e)); }
  art.trade_records_note = withTradesNote() + ` rebuilt=${art.trade_records.length} trades from top-${Math.min(50, (st.board || []).length)} rows.`;
  const body = JSON.stringify(art);
  const sha = await sha256hex(body);
  art.hashes.artifact = sha;
  const final = JSON.stringify(art);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([final], { type: 'application/json' }));
  a.download = `research_${st.runId || 'run'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  logLine(`audit artifact downloaded: research_${st.runId || 'run'}.json (${(final.length / 1024).toFixed(0)}KB, ${art.trade_records.length} trades, sha256=${sha.hash.slice(0, 16)}…)`);
  useStore.getState().set({ lastAudit: art });
}

export async function replayArtifactFile(f: File, onProgress?: (p: number) => void): Promise<void> {
  const text = await f.text();
  if (onProgress) onProgress(30);
  let art: any;
  try { art = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
  if (!art || !art.candidate_results) throw new Error('not an XBOST audit artifact (missing candidate_results)');
  if (onProgress) onProgress(60);
  const rep = engine.replayAudit(art);
  if (onProgress) onProgress(100);
  const out = [
    `REPLAY ${art.run_manifest?.run_id || '?'}: ${rep.pass ? 'REPLAY_STATUS=PASS' : 'REPLAY_STATUS=FAIL'}`,
    ...rep.checks.map((c: any) => `  ${c.name}=${c.pass ? 'PASS' : 'FAIL'}${c.detail ? ` (${c.detail})` : ''}`),
    ...rep.mismatches.slice(0, 10).map((m: any) => `  MISMATCH ${m.candidate_id} ${m.field}: ${JSON.stringify(m.original)} vs ${JSON.stringify(m.replayed)}`),
  ];
  useStore.getState().set({ validation: out, valOk: rep.pass });
  out.forEach(l => logLine('[replay] ' + l));
}

// ---------- Dynamic time-of-day profiles (§TOD) ----------
// Post-pass: rebuilds trades for top board rows on TRAIN/OOS splits,
// attributes (bucket, family, direction, regime, TF, instrument, expiry),
// discovers per-market cells, validates OOS, versions + locks profiles,
// and runs the futures→options transfer test. All caps + logged.
export function buildProfiles(bd: BoardRow[], symData: [string, OHLCV][], opts: any, mySeq: number) {
  try {
    const st = useStore.getState();
    const rows = (bd || []).slice(0, 60);
    if (!rows.length) { logLine('profiles: no rows'); return; }
    const tfCache: Record<string, any> = {};
    const getTD = (sym: string, tf: number, slice: 'train' | 'oos') => {
      const sd = symData.find(([s]) => s === sym);
      if (!sd) return null;
      const raw = sd[1];
      const split = Math.floor(raw.t.length * (st.wfSplit || 70) / 100);
      const purge = Math.max(0, Math.round(st.purgeBars || 0));
      const s0 = slice === 'train' ? 0 : Math.min(raw.t.length - 1, split + purge);
      const s1 = slice === 'train' ? split : raw.t.length;
      if (s1 - s0 < 50) return null;
      const pk = (a: Float64Array) => a.slice(s0, s1);
      const key = sym + '|' + tf + '|' + slice;
      if (!tfCache[key]) {
        const d = engine.resample({ t: pk(raw.t), o: pk(raw.o), h: pk(raw.h), l: pk(raw.l), c: pk(raw.c), v: pk(raw.v) } as any, tf);
        tfCache[key] = d;
      }
      return tfCache[key];
    };
    const dayRegCache: Record<string, any> = {};
    const dayRegOf = (sym: string, tf: number, slice: 'train' | 'oos', idx: number): string => {
      try {
        const d = getTD(sym, tf, slice);
        if (!d) return '?';
        const key = sym + '|' + tf + '|' + slice;
        if (!dayRegCache[key]) dayRegCache[key] = engine.dayRouting(d, { source: opts.regimeSource || 'rules', confGate: opts.confGate ?? 0.6 });
        const rt = dayRegCache[key];
        if (!rt.dayReg) return '?';
        for (let s = 0; s < rt.dayReg.segs.length; s++) {
          const sg = rt.dayReg.segs[s];
          if (idx >= sg.s && idx < sg.e) {
            const p = rt.dayReg.pred[s];
            if (p < 0) return 'FB';
            return String(p);
          }
        }
        return '?';
      } catch { return '?'; }
    };
    const effFor = (d: any, r: BoardRow) => {
      const base = opts;
      let mi = engine.buildSessionMask(d, base.sessionStart, base.sessionEnd);
      mi = engine.combineMasks(mi, engine.buildWindowMask(d.t, base.tradeWindows)) as Int8Array;
      mi = engine.combineMasks(mi, engine.buildExpiryMask(d, base.excludeExpiry)) as Int8Array;
      if (base.ivMaxRank != null && base.ivMaxRank < 1) mi = engine.combineMasks(mi, engine.ivRankMask(d, base.ivMaxRank, 20, 75600).mask) as Int8Array;
      const eff: any = Object.assign({}, base, {
        sessionMask: r.carry ? new Int8Array(d.c.length).fill(1) : mi,
        slPct: r.slPct, tpPct: r.tpPct, trailPct: r.trailPct ?? base.trailPct,
        exit: r.exit || 'fixed', carry: !!r.carry,
      });
      return eff;
    };
    const isOptSym = (sym: string, dsRaw?: any) => {
      const c = dsRaw && dsRaw.contract;
      if (c && c.strike != null) return true;
      const k = (sym || '').toUpperCase().replace(/[^A-Z]/g, '');
      return /(CE|PE)$/.test(k) || k.includes('OPTION');
    };
    const marketOf = (sym: string) => {
      const s = (sym || '').toUpperCase();
      if (s.includes('BANKNIFTY') || s.includes('BANKEX')) return 'BANKNIFTY';
      if (s.includes('NIFTY') || s.includes('SENSEX')) return 'NIFTY';
      if (s.includes('CRUDE')) return 'CRUDE';
      return 'OTHER';
    };
    // per-row train/oos trades with attribution
    type PT = { pnl: number; entryTime: number; session: string; expiry: string; family: string; direction: string; regime: string; timeframe: number; fold: string; mae: number; mfe: number; hold: number };
    const byGroup: Record<string, PT[]> = {};
    const rowConcentration: Record<string, any> = {};
    let rebuilt = 0;
    for (const r of rows) {
      if (useStore.getState().runSeq !== mySeq) return;
      const sym = r.symbol || '';
      const sd = symData.find(([s]) => s === sym);
      const raw = sd ? sd[1] : null;
      const cmeta = (raw as any)?.contract || (useStore.getState().datasets[sym]?.raw as any)?.contract || {};
      const fam = (((engine as any).FAMILY || {})[r.indicator] || '?');
      const all: PT[] = [];
      for (const slice of ['train', 'oos'] as const) {
        const d = getTD(sym, r.timeframe, slice);
        if (!d) continue;
        const sig = engine.buildSignals(d, { indicator: r.indicator, params: r.params });
        const bt = engine.backtest(d, sig.pos, effFor(d, r));
        const span = slice === 'train' ? d.t[d.t.length - 1] - d.t[0] : 0;
        const fOf = (t: number) => {
          if (slice === 'oos') return 'oos';
          const f = Math.min(2, Math.floor(3 * (t - d.t[0]) / Math.max(1, span)));
          return 'train' + (f + 1);
        };
        for (const t of bt.trades) {
          all.push({
            pnl: t.pnl, entryTime: t.entryTime, session: engine.istDayKey(t.entryTime),
            expiry: cmeta.expiry || '', family: fam, direction: t.type,
            regime: dayRegOf(sym, r.timeframe, slice, t.entryIdx),
            timeframe: r.timeframe, fold: fOf(t.entryTime),
            mae: (t as any).mae || 0, mfe: (t as any).mfe || 0, hold: t.exitIdx - t.entryIdx,
          });
        }
      }
      if (!all.length) continue;
      rebuilt++;
      const key = marketOf(sym) + '|' + (isOptSym(sym, (raw as any)) ? 'OPT' : 'FUT');
      (byGroup[key] = byGroup[key] || []).push(...all.map(t => Object.assign(t, { _sym: sym })));
      // concentration flags for this candidate
      const bySess: Record<string, number> = {};
      for (const t of all) bySess[t.session] = (bySess[t.session] || 0) + t.pnl;
      const sess = Object.keys(bySess).length;
      const tot = Math.abs(all.reduce((a, t) => a + t.pnl, 0)) || 1e-9;
      const topSess = Math.max(...Object.values(bySess).map(v => Math.abs(v))) / tot;
      const exps = new Set(all.map(t => t.expiry).filter(Boolean)).size;
      (r as any).concentration = {
        sessions: sess, topSessionPct: +(100 * topSess).toFixed(1), expiries: exps,
        timeConcentrated: topSess > 0.6 || sess < 5,
      };
      rowConcentration[engine.cfgKey(r as any)] = (r as any).concentration;
    }
    // per-group profiles
    const profiles: any[] = [];
    const dataHash = engine.hashRecord(symData.map(([s, d]) => `${s}:${d.t.length}:${d.t[0] ?? 0}`).join('|'));
    for (const gk of Object.keys(byGroup)) {
      const [market, inst] = gk.split('|');
      // one profile per timeframe present
      const tfs = [...new Set(byGroup[gk].map(t => t.timeframe))];
      for (const tf of tfs) {
        const trades = byGroup[gk].filter(t => t.timeframe === tf);
        const cells = engine.aggregateProfile(trades);
        const classified: Record<string, any> = {};
        for (const k of Object.keys(cells)) classified[k] = engine.classifyCell(cells[k], {});
        const merged = engine.mergeBuckets(cells, classified);
        const eligible = Object.keys(cells).filter(k => classified[k].status === 'RANKABLE')
          .map(k => { const [bucket, family, direction, regime] = k.split('|'); return { bucket, family, direction, regime, timeframe: tf, status: 'RANKABLE', n: cells[k].train.n, sessions: cells[k].train.sessions, oos_expectancy: cells[k].oos.expectancy, oos_pf: cells[k].oos.profitFactor }; });
        profiles.push({
          profile_id: engine.profileId(market, inst === 'OPT' ? 'OPT' : 'FUT', String(tf), st.runId || 'norun', dataHash),
          market, instrument: inst === 'OPT' ? 'OPTIONS' : 'FUTURES', timeframe: tf,
          data_start: new Date(byGroup[gk][0].entryTime).toISOString(), data_end: new Date(byGroup[gk][byGroup[gk].length - 1].entryTime).toISOString(),
          generated_at: new Date().toISOString(), engine_version: '1.0.0', engine_hash: 'version-stamp-only (browser)',
          data_hash: dataHash, strategy_hash: engine.hashRecord(Object.keys(byGroup[gk]).length + ':' + tf),
          sampler_seed: 'deterministic (Halton/none)',
          validation_status: eligible.length ? 'HAS_RANKABLE_CELLS' : 'NO_RANKABLE_CELLS',
          parameters_locked: true, reoptimized: false,
          cells, classified, merged, eligible,
        });
      }
    }
    // transfer: futures vs options of the same market+TF on shared cell keys
    const transfer: any[] = [];
    const fProfs = profiles.filter(p => p.instrument === 'FUTURES');
    const oProfs = profiles.filter(p => p.instrument === 'OPTIONS');
    for (const fp of fProfs) for (const op of oProfs) {
      if (fp.market !== op.market || fp.timeframe !== op.timeframe) continue;
      const fCells: Record<string, any> = {}, oCells: Record<string, any> = {};
      for (const k of Object.keys(fp.cells)) { const p = k.split('|'); fCells[p.slice(0, 4).join('|')] = { status: fp.classified[k].status, train: fp.cells[k].train }; }
      for (const k of Object.keys(op.cells)) { const p = k.split('|'); oCells[p.slice(0, 4).join('|')] = { status: op.classified[k].status, train: op.cells[k].train }; }
      for (const k of Object.keys(fCells)) {
        if (!oCells[k]) continue;
        transfer.push({ market: fp.market, timeframe: fp.timeframe, cell: k, futures: fCells[k].status, options: oCells[k].status, result: engine.classifyTransfer(fCells[k], oCells[k]) });
      }
    }
    useStore.getState().set({ lastProfiles: profiles, lastTransfer: transfer });
    // ---- §24 report ----
    logLine('===== DYNAMIC TIME-OF-DAY DISCOVERY =====');
    logLine(`  rebuilt=${rebuilt} candidates (top-${rows.length} board, train+OOS trades) profiles=${profiles.length}`);
    for (const p of profiles) {
      logLine(`  ${p.profile_id}: ${p.validation_status} eligible=${p.eligible.length} merged=${p.merged.length} ranges=${p.data_start.slice(0, 10)}→${p.data_end.slice(0, 10)}`);
      p.eligible.slice(0, 6).forEach((e: any) => logLine(`    ELIGIBLE ${e.bucket} ${e.family}/${e.direction} n=${e.n} sess=${e.sessions} oos_exp=${e.oos_expectancy} oos_pf=${e.oos_pf}`));
    }
    logLine('===== TIME PROFILE ===== (NIFTY/BANKNIFTY × FUTURES/OPTIONS)');
    for (const p of profiles) logLine(`  ${p.profile_id}: ${p.eligible.length} eligible cells (${p.validation_status})`);
    if (!profiles.length) logLine('  TIME PROFILE = NONE (no attributed trades)');
    logLine('===== FUTURES → OPTIONS TRANSFER =====');
    if (!transfer.length) logLine('  TRANSFER = INSUFFICIENT_DATA (needs both instrument types in one run)');
    else {
      const counts: Record<string, number> = {};
      for (const t of transfer) counts[t.result] = (counts[t.result] || 0) + 1;
      logLine('  ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
      transfer.filter(t => t.result === 'TRANSFERRED').slice(0, 5).forEach(t => logLine(`  TRANSFERRED ${t.market} ${t.timeframe}m ${t.cell}`));
    }
    // concentration flags + cost-sensitivity on profiled rows
    try {
      let concLogged = 0;
      for (const r of rows.slice(0, 20)) {
        const cc = (r as any).concentration;
        if (cc && cc.timeConcentrated) {
          if (concLogged < 5) logLine(`  TIME_CONCENTRATED [${r.symbol}] ${r.indicator}: top-session ${cc.topSessionPct}% over ${cc.sessions} sessions, ${cc.expiries} expiries — cannot become BEST_ROBUST/PAPER`);
          concLogged++;
        }
      }
      if (concLogged > 5) logLine(`  …+${concLogged - 5} more TIME_CONCENTRATED rows`);
      const top5 = (useStore.getState().board || []).slice(0, 5);
      for (const r of top5) {
        const det = detailFor(r);
        if (!det) continue;
        const base = tradeOpts();
        const eff2: any = Object.assign({}, base, {
          sessionMask: new Int8Array(det.data.c.length).fill(1),
          slPct: r.slPct, tpPct: r.tpPct, trailPct: r.trailPct ?? base.trailPct,
          exit: r.exit || 'fixed', carry: !!r.carry,
        });
        const bt2 = engine.backtest(det.data, det.sig.pos, Object.assign({}, eff2, { cost: (base.cost || 0) * 2 }));
        if (det.bt.metrics.netPnL > 0 && bt2.metrics.netPnL <= 0)
          logLine(`  COST_SENSITIVITY_FAILURE [${r.symbol}] ${r.indicator}: +P&L at 1x cost, ≤0 at 2x cost`);
      }
    } catch (e: any) { logLine('cost-sensitivity check skipped: ' + (e?.message || e)); }
  } catch (e: any) { logLine('profiles skipped: ' + (e?.message || e)); }
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

function hasTierLabel(): string {  const cur = useStore.getState().inds;
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
  let det = null;
  try {
    det = detailFor(r);
  } catch (e: any) {
    useStore.getState().set({ alert: `Could not render [${r.symbol}] ${r.indicator}: ${(e?.message || e)}` });
    logLine(`detail ERROR: ${(e?.message || e)}`);
    return;
  }
  if (!det) return;
  useStore.getState().set({ sel: r, detail: det });
}

