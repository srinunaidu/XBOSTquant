/* Grid-search Web Worker — loads engine.js via importScripts.
   Stage 1: exhaustive Cartesian grid. Stage 2: hill-climb refinement of the
   top rows (neighbors ±1 step incl. SL/TP) until no improvement. */
try { importScripts('engine.js'); } catch(e) {}
try { importScripts('robustness.js'); } catch(e) {}

self.onmessage = async function(e) {
  const msg = e.data;
  if (msg.type !== 'run') return;
  const E = self.XBOST_ENGINE;
  const d1m = {
    t: new Float64Array(msg.t),
    o: new Float64Array(msg.o),
    h: new Float64Array(msg.h),
    l: new Float64Array(msg.l),
    c: new Float64Array(msg.c),
    v: new Float64Array(msg.v)
  };
  const grid = msg.grid;
  const tradeOpts = msg.tradeOpts;
  const objective = msg.objective;
  const topN = msg.topN || 500;
  const batch = 25;
  const results = [];
  let errCount = 0;
  const errSamples = []; // first errors, shipped to the debug log
  // cache resampled bars + session masks per timeframe (built ONCE, reused by all combos)
  // maskIn flattens outside session (intraday); maskCarry holds overnight.
  // Single-TF cache only (grid runs TF-major, so memory stays bounded).
  // Also caches rule-regimes per TF; ML weights/preds train lazily once per TF.
  let tfCache = null;
  const mlInfo = [];
  function getTF(tf){
    if(!tfCache || tfCache.tf !== tf){
      const d=E.resample(d1m, tf);
      tfCache={tf, d, maskIn:E.buildSessionMask(d, tradeOpts.sessionStart, tradeOpts.sessionEnd),
        maskCarry:new Int8Array(d.c.length).fill(1), win:E.buildWindowMask(d.t, tradeOpts.tradeWindows),
        reg:E.regimeSeries(d, {}), ml:null};
    }
    return tfCache;
  }
  const routeNotices = [];
  const routeSeen = {};
  function noteTF(tf, arr){ if(routeSeen[tf])return; routeSeen[tf]=1; (arr||[]).forEach(n=>routeNotices.push(tf+'m: '+n)); }
  // Single choke-point for routing (day default, bar advanced). Returns a bar
  // mask or null (= run unrouted, always with a logged reason).
  function tradeMaskFor(cfg){
    if(!tradeOpts.regimeOn) return null;
    const dd = getTF(cfg.timeframe);
    const gate = tradeOpts.confGate != null ? tradeOpts.confGate : 0.6;
    if((tradeOpts.granularity || 'day') === 'day'){
      if(!dd.dayRT) dd.dayRT = E.dayRouting(dd.d, {source: tradeOpts.regimeSource, confGate: gate});
      const rt = dd.dayRT;
      noteTF(cfg.timeframe, rt.notices);
      if(!rt.dayReg) return null;
      if(!routeSeen[cfg.timeframe + 'fb']){
        routeSeen[cfg.timeframe + 'fb'] = 1;
        let fbD = 0; const total = rt.dayReg.pred.length;
        for(let s = 0; s < total; s++) if(rt.dayReg.pred[s] < 0 || (rt.dayReg.conf && rt.dayReg.conf[s] < gate)) fbD++;
        routeNotices.push(cfg.timeframe + 'm: ' + fbD + '/' + total + ' fallback days (unrouted, counted)');
      }
      return E.dayRegimeMask(dd.d, rt.dayReg, cfg.indicator, gate).mask;
    }
    // bar mode (advanced): per-bar regimes; ML trains lazily once per TF
    const regs = tradeOpts.regimeSource === 'ml' ? getML(cfg.timeframe).pred : dd.reg;
    return E.regimeMask(Array.isArray(regs) ? Int8Array.from(regs) : regs, cfg.indicator);
  }
  function getML(tf){
    const tfc = getTF(tf);
    if(!tfc.ml && tradeOpts.regimeSource === 'ml'){
      const t0 = Date.now();
      const r = E.trainRegimeML(tfc.d, 0.7, 15, 200);
      tfc.ml = { pred: r.pred, trainAcc: r.trainAcc };
      mlInfo.push({ tf, trainAcc: +r.trainAcc.toFixed(3), ms: Date.now() - t0 });
    }
    return tfc.ml;
  }
  // SIGNAL CACHE: indicators for one (tf, indicator, params) set are computed
  // ONCE and reused across all SL/TP/exit/carry variants (the expensive part).
  // Grid arrives sorted TF-major with identical signals adjacent, so one live
  // entry suffices — memory stays O(1).
  let sigCache = { key: null, sig: null };
  function getSig(cfg){
    const k = cfg.timeframe + '|' + cfg.indicator + '|' + JSON.stringify(cfg.params);
    if(sigCache.key !== k){
      const dd = getTF(cfg.timeframe);
      sigCache = { key: k, sig: E.buildSignals(dd.d, cfg) };
    }
    return sigCache.sig;
  }
  function testCfg(cfg, idx, refined){
    const eff = Object.assign({}, tradeOpts);
    if(cfg.slPct!=null) eff.slPct=cfg.slPct;
    if(cfg.tpPct!=null) eff.tpPct=cfg.tpPct;
    if(cfg.trailPct!=null) eff.trailPct=cfg.trailPct;
    eff.exit = cfg.exit||'fixed';
    eff.carry = !!cfg.carry;
    const xo = E.exitOptsFromParams(cfg.indicator, cfg.params||{});
    if(xo){ eff.ckPeriod = xo.ckPeriod; eff.ckMult = xo.ckMult; }
    const tm = tradeMaskFor(cfg);
    if(tm) eff.tradeMask = tm;
    const mk = (m, err) => ({ i: idx, symbol: msg.symbol || '', timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params,
      slPct: eff.slPct||0, tpPct: eff.tpPct||0, trailPct: eff.trailPct||0,
      exit: eff.exit, carry: eff.carry, refined: !!refined, m: m, err: err });
    try {
      const dd = getTF(cfg.timeframe);
      eff.sessionMask = E.combineMasks(eff.carry ? dd.maskCarry : dd.maskIn, dd.win);
      const sig = getSig(cfg); // cached: computed once per (tf, indicator, params)
      const bt = E.backtest(dd.d, sig.pos, eff);
      return mk(bt.metrics);
    } catch(err){
      errCount++;
      if(errSamples.length < 10) errSamples.push(cfg.indicator + ' ' + cfg.timeframe + 'm ' + JSON.stringify(cfg.params) + ' :: ' + String(err && err.message || err).slice(0, 160));
      return mk({netPnL:0,winRate:0,totalTrades:0,profitFactor:0,maxDD:0,sharpe:-99,sortino:-99,expectancy:0,finalCapital:tradeOpts.capital||100000,tradesPerDay:0,days:0}, String(err));
    }
  }
  // ---------- stage 1: exhaustive grid ----------
  const total = grid.length;
  for (let i=0;i<total;i++){
    results.push(testCfg(grid[i], i));
    if ((i+1)%batch===0 || i===total-1){
      const ranked = E.rankResults(results, objective).slice(0, topN);
      const cfg = grid[i];
      self.postMessage({ type:'progress', stage:'grid', done:i+1, total, top:ranked, errCount:errCount,
        current:{ indicator:cfg.indicator, timeframe:cfg.timeframe, params:cfg.params, slPct:cfg.slPct||tradeOpts.slPct||0, tpPct:cfg.tpPct||tradeOpts.tpPct||0, exit:cfg.exit||'fixed', carry:!!cfg.carry } });
    }
  }
  // ---------- stage 2: hill-climb until best (max 4 passes over top-20) ----------
  const tested = new Set(grid.map(c=>E.cfgKey(c)));
  const stepsByInd = msg.paramSteps || {};
  const riskSteps = {sl: msg.slStep || 0, tp: msg.tpStep || 0};
  let pool = E.rankResults(results, objective).slice(0, 20);
  let best = E.objectiveValue(pool[0].m, objective);
  let pass = 0, refined = 0;
  let improved = true;
  while (improved && pass < 4) {
    improved = false; pass++;
    const cands = [];
    for (const row of pool) {
      const nbs = E.paramNeighbors(row, stepsByInd[row.indicator] || {}, riskSteps);
      for (const nb of nbs) {
        const k = E.cfgKey(nb);
        if (!tested.has(k)) { tested.add(k); nb.refined = true; cands.push(nb); }
      }
      if (cands.length > 600) break;
    }
    if (!cands.length) break;
    for (let j = 0; j < cands.length; j++) {
      results.push(testCfg(cands[j], total + refined, true));
      refined++;
      if ((j+1) % 25 === 0 || j === cands.length - 1) {
        const ranked = E.rankResults(results, objective).slice(0, topN);
        self.postMessage({ type:'progress', stage:'refine', done:total + refined, total: total + '+refine',
          top: ranked, errCount: errCount, pass: pass,
          current:{ indicator:cands[j].indicator, timeframe:cands[j].timeframe, params:cands[j].params,
            slPct:cands[j].slPct||0, tpPct:cands[j].tpPct||0,
            exit:cands[j].exit||'fixed', carry:!!cands[j].carry } });
      }
    }
    pool = E.rankResults(results, objective).slice(0, 20);
    const nowBest = E.objectiveValue(pool[0].m, objective);
    if (nowBest > best + 1e-9) { best = nowBest; improved = true; }
  }
  let ranked = E.rankResults(results, objective);
  // §27 staged robustness: cheap on Top-500, medium on Top-100, full on Top-25
  const Rb = (typeof XBOST_ROBUST !== 'undefined' ? XBOST_ROBUST : null);
  if (Rb) {
    const totalCombos = grid.length * (tradeOpts.sym || 'data').length || grid.length;
    const tfs = (() => {
      try {
        const tf = ranked[0]?.timeframe || 5;
        const d = getTF(tf).d;
        return d;
      } catch { return null; }
    })();
    if (tfs) {
      for (let i = 0; i < Math.min(ranked.length, 25); i++) {
        const cand = ranked[i];
        const d0 = getTF(cand.timeframe).d;
        try {
          const r = await Rb.robustnessFor(d0, cand, Object.assign({}, tradeOpts), null, totalCombos, i + 1);
          cand.robustness = r;
          cand.robustScore = r.final.adjusted;
        } catch (e) { cand.robustError = String(e && e.message || e); }
      }
      // re-rank Top-25 by robustness score (§24: robustness first)
      const top25 = ranked.slice(0, 25).sort((a, b) => (b.robustScore || 0) - (a.robustScore || 0));
      ranked = top25.concat(ranked.slice(25));
    }
  }
  self.postMessage({ type:'done', done:total + refined, total: total + refined, top:ranked.slice(0, topN),
    all:ranked.slice(0, topN), errCount:errCount, errSamples:errSamples, refined:refined, passes:pass, ml:mlInfo, route:routeNotices });
};
