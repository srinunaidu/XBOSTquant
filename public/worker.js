/* Grid-search Web Worker — loads engine.js via importScripts.
   Stage 1: exhaustive Cartesian grid. Stage 2: hill-climb refinement of the
   top rows (neighbors ±1 step incl. SL/TP) until no improvement. */
try { importScripts('engine.js'); } catch(e) {}
try { importScripts('robustness.js'); } catch(e) {}

self.onmessage = async function(e) {
  const msg = e.data;
  if (msg.type !== 'run') return;
  try {
    await runGridSearch(msg);
  } catch (err) {
    // NEVER hang silently: the runner treats this as a failed worker and
    // surfaces the message (previously any throw = infinite "warming up").
    self.postMessage({ type: 'error', message: String((err && err.message) || err).slice(0, 500) });
  }
};

async function runGridSearch(msg) {
  const E = self.XBOST_ENGINE;
  if (!E) throw new Error('XBOST_ENGINE missing in worker (engine.js failed to load)');
  if (!msg.grid || !msg.grid.length) throw new Error('empty grid — nothing to search (check indicator selection)');
  const heapMB = () => { try { const m = performance.memory?.usedJSHeapSize; return m ? Math.round(m / 1048576) : null; } catch { return null; } };
  const d1m = {
    t: new Float64Array(msg.t),
    o: new Float64Array(msg.o),
    h: new Float64Array(msg.h),
    l: new Float64Array(msg.l),
    c: new Float64Array(msg.c),
    v: new Float64Array(msg.v)
  };
  const und1m = msg.und ? {
    t: new Float64Array(msg.und.t),
    o: new Float64Array(msg.und.o),
    h: new Float64Array(msg.und.h),
    l: new Float64Array(msg.und.l),
    c: new Float64Array(msg.und.c),
    v: new Float64Array(msg.und.v)
  } : null;
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
      // Structural masks: expiry-day exclusion + IV-rank cheap-vol filter.
      // ANDed into the intraday mask once per TF (carry legs bypass all).
      let mi=tfCache.maskIn;
      mi=E.combineMasks(mi, E.buildExpiryMask(d, tradeOpts.excludeExpiry));
      if(tradeOpts.ivMaxRank!=null&&tradeOpts.ivMaxRank<1){
        const ivm=E.ivRankMask(d, tradeOpts.ivMaxRank, 20, 75600);
        if(ivm.insufficient) routeNotices.push(tf+'m: IV-rank insufficient history — filter inactive (needs a longer file)');
        else{
          let blocked=0; for(let i=0;i<ivm.mask.length;i++) if(!ivm.mask[i]) blocked++;
          routeNotices.push(tf+'m: IV-rank filter ≤'+tradeOpts.ivMaxRank+' blocks '+(100*blocked/ivm.mask.length).toFixed(1)+'% of bars');
        }
        mi=E.combineMasks(mi, ivm.mask);
      }
      tfCache.maskIn=mi;
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
      let dayReg = rt.dayReg;
      if(tradeOpts.routerV2){
        const vk = 'v2_' + (tradeOpts.routerPersist || 5) + '_' + (tradeOpts.routerHyst || 2);
        if(!dd.dayRTv2 || dd.dayRTv2.k !== vk){
          dd.dayRTv2 = {k: vk, pred: Array.from(E.smoothRegime(Int8Array.from(dayReg.pred), tradeOpts.routerPersist || 5, tradeOpts.routerHyst || 2))};
        }
        dayReg = Object.assign({}, dayReg, {pred: dd.dayRTv2.pred});
      }
      if(!routeSeen[cfg.timeframe + 'fb']){
        routeSeen[cfg.timeframe + 'fb'] = 1;
        let fbD = 0; const total = rt.dayReg.pred.length;
        for(let s = 0; s < total; s++) if(rt.dayReg.pred[s] < 0 || (rt.dayReg.conf && rt.dayReg.conf[s] < gate)) fbD++;
        routeNotices.push(cfg.timeframe + 'm: ' + fbD + '/' + total + ' fallback days (unrouted, counted)');
      }
      return E.dayRegimeMask(dd.d, dayReg, cfg.indicator, gate).mask;
    }
    // bar mode (advanced): per-bar regimes; ML trains lazily once per TF
    const regs = tradeOpts.regimeSource === 'ml' ? getML(cfg.timeframe).pred : dd.reg;
    let regArr = Array.isArray(regs) ? Int8Array.from(regs) : regs;
    if(tradeOpts.routerV2){
      const vk = 'v2b_' + (tradeOpts.routerPersist || 5) + '_' + (tradeOpts.routerHyst || 2);
      if(!dd.regSm || dd.regSm.k !== vk) dd.regSm = {k: vk, arr: E.smoothRegime(regArr, tradeOpts.routerPersist || 5, tradeOpts.routerHyst || 2)};
      regArr = dd.regSm.arr;
    }
    return E.regimeMask(regArr, cfg.indicator);
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
      if(tradeOpts.sigSource === 'underlying' && und1m){
        const al = E.underlyingSignal(dd.d, und1m, cfg.timeframe, cfg);
        if(!sigCache.undLogged || sigCache.undLogged !== cfg.timeframe){
          sigCache.undLogged = cfg.timeframe;
          routeNotices.push(cfg.timeframe + 'm: underlying-led signals (' + al.aligned + '/' + al.pos.length + ' bars aligned, causal last-known)');
        }
        sigCache = { key: k, sig: { pos: al.pos }, undLogged: sigCache.undLogged };
      } else {
        sigCache = { key: k, sig: E.buildSignals(dd.d, cfg) };
      }
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
      self.postMessage({ type:'progress', stage:'grid', done:i+1, total, top:ranked, errCount:errCount, heap:heapMB(),
        current:{ indicator:cfg.indicator, timeframe:cfg.timeframe, params:cfg.params, slPct:cfg.slPct||tradeOpts.slPct||0, tpPct:cfg.tpPct||tradeOpts.tpPct||0, exit:cfg.exit||'fixed', carry:!!cfg.carry } });
    }
  }
  // ---------- stage 2: hill-climb until best (max 4 passes over top-20) ----------
  const tested = new Set(grid.map(c=>E.cfgKey(c)));
  const stepsByInd = msg.paramSteps || {};
  const riskSteps = {sl: msg.slStep || 0, tp: msg.tpStep || 0};
  let pool = E.rankResults(results, objective).slice(0, 20);
  if (!pool.length) throw new Error('no evaluable combos — every configuration errored (see combo errors)');
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
          top: ranked, errCount: errCount, heap: heapMB(), pass: pass,
          current:{ indicator:cands[j].indicator, timeframe:cands[j].timeframe, params:cands[j].params,
            slPct:cands[j].slPct||0, tpPct:cands[j].tpPct||0,
            exit:cands[j].exit||'fixed', carry:!!cands[j].carry } });
      }
    }
    pool = E.rankResults(results, objective).slice(0, 20);
    const nowBest = E.objectiveValue(pool[0].m, objective);
    if (nowBest > best + 1e-9) { best = nowBest; improved = true; }
  }
  // ---------- stage 3: Bayesian EI proposals (GP over evaluated top rows) ----------
  if (msg.useBayes !== false) {
    try {
      const cands = E.bayesianRefine(E.rankResults(results, objective).slice(0, 40), stepsByInd, 24)
        .filter(nb => !tested.has(E.cfgKey(nb)));
      for (const nb of cands) tested.add(E.cfgKey(nb));
      for (let j = 0; j < cands.length; j++) {
        results.push(testCfg(cands[j], total + refined, true));
        refined++;
      }
      if (cands.length) {
        const ranked = E.rankResults(results, objective).slice(0, topN);
        self.postMessage({ type:'progress', stage:'bayes', done: total + refined, total: total + '+refine+bayes',
          top: ranked, errCount: errCount, heap: heapMB(), pass: pass,
          current:{ indicator:'EI', timeframe:'—', params:{proposals: cands.length}, slPct:0, tpPct:0, exit:'fixed', carry:false } });
      }
    } catch (e) { /* best-effort */ }
  }
  let ranked = E.rankResults(results, objective);
  // §27 staged robustness: cheap on Top-500, medium on Top-100, full on Top-25
  let robustnessLogs = [];
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
          // Same execution the board ranked: candidate SL/TP/exit/carry are
          // applied inside robustnessFor via effOptsFor; the regime tradeMask
          // must travel in baseOpts (it is data-derived, not serializable).
          const rbo = Object.assign({}, tradeOpts);
          const tm = tradeMaskFor(cand);
          if (tm) rbo.tradeMask = tm;
          // Session mask WITH expiry/IV/window overlays (mirrors testCfg) —
          // effOptsFor preserves caller masks and rebuilds only if absent.
          try {
            const dd = getTF(cand.timeframe);
            rbo.sessionMask = cand.carry ? dd.maskCarry : dd.maskIn;
          } catch (e) { /* effOptsFor rebuilds from session hours */ }
          if (tradeOpts.sigSource === 'underlying' && und1m) { rbo.undD = und1m; rbo.undTF = cand.timeframe; }
          const r = await Rb.robustnessFor(d0, cand, rbo, null, totalCombos, i + 1);
          cand.robustness = r;
          cand.robustScore = r.final.adjusted;
          // cap at 6.8 until full suite is logged (§26 gate)
          if (!r.paramStability || !r.signalPurity || !r.regimeRobustness || !r.entryPerturbation || !r.worstTradeRemoval || !r.concentration || r.tradeOrder == null) {
            cand.robustScore = Math.min(cand.robustScore, 6.8);
          }
        } catch (e) { cand.robustError = String(e && e.message || e); cand.robustScore = Math.min(cand.robustScore || 0, 6.8); }
        // Stage heartbeat: robustness is the longest silent phase — post per
        // candidate so the UI (and the 90s watchdog) sees proof of life.
        self.postMessage({ type: 'progress', stage: 'robust', done: i + 1, total: Math.min(ranked.length, 25),
          top: ranked.slice(0, topN), errCount: errCount, heap: heapMB(),
          current: { sym: msg.symbol, indicator: 'robustness', timeframe: cand.timeframe, params: { candidate: i + 1 }, slPct: 0, tpPct: 0, exit: 'fixed', carry: false } });
      }
      // build machine logs for #1 (§26)
      const top = ranked[0];
      if (top && top.robustness) {
        const r = top.robustness;
        const ps = r.paramStability, ex = r.exitIndependence, sp = r.signalPurity, rg = r.regimeRobustness, tm = r.timeRobustness, en = r.entryPerturbation, inp = r.inputPerturbation, tr = r.tradeOrder, co = r.concentration, wt = r.worstTradeRemoval;
        robustnessLogs.push(`[ROBUSTNESS START] candidate_id=${top.symbol||''}_${top.timeframe}m_${top.indicator} instrument=${top.symbol||''} timeframe=${top.timeframe}m indicator=${top.indicator} parameters=${JSON.stringify(top.params)} direction=${tradeOpts.direction} entry=${tradeOpts.entry} exit=${top.exit} optimized=true combinations_tested=${totalCombos} candidate_rank=1`);
        robustnessLogs.push(`[CORE SIGNAL] WR=${r.baseline.winRate.toFixed(2)} trades=${top.m?.totalTrades||0} expectancy=${r.baseline.expectancy.toFixed(4)} profit_factor=${r.baseline.profitFactor.toFixed(2)} sharpe=${r.baseline.sharpe.toFixed(2)} sortino=${r.baseline.sortino?.toFixed(2)||0} max_dd=${r.baseline.maxDD?.toFixed(2)||0} avg_mae=${r.baseline.avgMAE?.toFixed(2)||0} avg_mfe=${r.baseline.avgMFE?.toFixed(2)||0}`);
        if (ps) robustnessLogs.push(`[PARAMETER STABILITY] neighbors=${ps.neighbors} profitable=${ps.profitable} density=${(ps.density*100).toFixed(1)} median_sharpe=${ps.medianSharpe.toFixed(2)} p5_sharpe=${ps.p5Sharpe.toFixed(2)} worst_sharpe=${ps.worstSharpe.toFixed(2)} best_sharpe=${ps.bestSharpe.toFixed(2)} sd_sharpe=${ps.sdSharpe.toFixed(2)}`);
        if (ex) robustnessLogs.push(`[EXIT INDEPENDENCE] variants=${ex.variants} profitable=${ex.profitable} median_sharpe=${ex.medianSharpe.toFixed(2)} worst=${ex.worstSharpe.toFixed(2)} best=${ex.bestSharpe.toFixed(2)}`);
        if (sp) robustnessLogs.push(`[SIGNAL PURITY] indicator_only_sharpe=${sp.indicatorOnly.sharpe.toFixed(2)} regime_sharpe=${sp.regimeSharpe!=null?sp.regimeSharpe.toFixed(2):'NA'} full_sharpe=${sp.full.sharpe.toFixed(2)} purity=${sp.ratio.toFixed(2)}`);
        if (rg) robustnessLogs.push(`[REGIME ROBUSTNESS] regimes=4 profitable=${rg.profitableRegimes} worst_sharpe=${rg.worstSharpe.toFixed(2)} median_sharpe=${rg.medianSharpe.toFixed(2)}`);
        if (tm) robustnessLogs.push(`[TIME ROBUSTNESS] windows=4 profitable=${tm.profitableWindows} median_sharpe=${tm.medianSharpe.toFixed(2)} worst=${tm.worstSharpe.toFixed(2)} concentration=${(tm.concentration*100).toFixed(1)}%`);
        if (en) robustnessLogs.push(`[ENTRY PERTURBATION] variants=${en.variants} profitable=${en.profitable} median_sharpe=${en.medianSharpe.toFixed(2)} worst=${en.worstSharpe.toFixed(2)}`);
        if (inp) robustnessLogs.push(`[INPUT PERTURBATION] tests=${inp.total} profitable=${inp.profitable} median_sharpe=${inp.medianSharpe.toFixed(2)} worst=${inp.worstSharpe.toFixed(2)}`);
        if (co) robustnessLogs.push(`[P&L CONCENTRATION] top1=${co.top1Pct.toFixed(1)}% top5=${co.top5Pct.toFixed(1)}% top10=${co.top10Pct.toFixed(1)}% largest=${co.largestWinnerPct.toFixed(1)}%`);
        if (wt) robustnessLogs.push(`[BEST TRADE REMOVAL] remove1_sharpe=${wt.remove1.sharpe.toFixed(2)} remove3=${wt.remove3.sharpe.toFixed(2)} remove5=${wt.remove5.sharpe.toFixed(2)} remove10=${wt.remove10.sharpe.toFixed(2)}`);
        if (r.paramSensitivity) robustnessLogs.push(`[PARAM SENSITIVITY] ${r.paramSensitivity.skipped ? `SKIPPED (n=${r.paramSensitivity.baseTrades}<30)` : `pss=${r.paramSensitivity.pss} knife_edge=${r.paramSensitivity.knifeEdge ? 'YES' : 'no'} base_sharpe=${r.paramSensitivity.baseSharpe}`}`);
        if (r.blockBootstrap) {
          if (r.blockBootstrap.status === 'OK' && r.blockBootstrap.nSamples) robustnessLogs.push(`[BLOCK BOOTSTRAP] status=OK method=block iters=${r.blockBootstrap.iters} block=${r.blockBootstrap.block} seed=${r.blockBootstrap.seed} n=${r.blockBootstrap.n} sharpe_CI=[${r.blockBootstrap.sharpe}] wr_CI=[${r.blockBootstrap.wr}] pf_CI=[${r.blockBootstrap.pf}]`);
          else robustnessLogs.push(`[BLOCK BOOTSTRAP] BOOTSTRAP_STATUS=SKIPPED BOOTSTRAP_REASON=${(r.blockBootstrap && r.blockBootstrap.reason) || 'INSUFFICIENT_SAMPLE'} (never a [0,0] interval)`);
        }
        if (r.surrogate) robustnessLogs.push(`[SURROGATE] ${r.surrogate.skipped ? 'SKIPPED (<20 trades)' : `p=${r.surrogate.p} observed_sharpe=${r.surrogate.observedSharpe} n=${r.surrogate.nSurr}`} (edge real iff p<0.01)`);
        if (r.freeParams != null) robustnessLogs.push(`[PARAM COUNT] free_params=${r.freeParams} (cap 8)`);
        robustnessLogs.push(`[MULTIPLE TESTING] total_combinations=${totalCombos} candidate_rank=1 percentile=${(100*(1-1/totalCombos)).toFixed(2)} penalty=${r.final.penalty.toFixed(2)}`);
        robustnessLogs.push(`[FINAL] raw=${r.final.raw.toFixed(2)} adjusted=${r.final.adjusted.toFixed(2)} cap=${r.final.cap} classification=${r.classification} robustScore=${(top.robustScore||0).toFixed(2)}/10`);
      }
      // re-rank Top-25 by robustness score (§24: robustness first)
      const top25 = ranked.slice(0, 25).sort((a, b) => (b.robustScore || 0) - (a.robustScore || 0));
      ranked = top25.concat(ranked.slice(25));
    }
  }
  self.postMessage({ type:'done', done:total + refined, total: total + refined, top:ranked.slice(0, topN),
    all:ranked.slice(0, topN), errCount:errCount, errSamples:errSamples, refined:refined, passes:pass, ml:mlInfo, route:routeNotices, robustnessLogs:robustnessLogs });
}
