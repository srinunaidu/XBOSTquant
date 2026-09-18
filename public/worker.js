/* Grid-search Web Worker — loads engine.js via importScripts.
   Stage 1: exhaustive Cartesian grid. Stage 2: hill-climb refinement of the
   top rows (neighbors ±1 step incl. SL/TP) until no improvement. */
try { importScripts('engine.js'); } catch(e) {}

self.onmessage = function(e) {
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
  // cache resampled bars + session masks per timeframe (built ONCE, reused by all combos)
  // maskIn flattens outside session (intraday); maskCarry holds overnight
  const cache = {};
  function getTF(tf){
    if(!cache[tf]){
      const d=E.resample(d1m, tf);
      cache[tf]={d, maskIn:E.buildSessionMask(d, tradeOpts.sessionStart, tradeOpts.sessionEnd),
        maskCarry:new Int8Array(d.c.length).fill(1)};
    }
    return cache[tf];
  }
  function testCfg(cfg, idx, refined){
    const eff = Object.assign({}, tradeOpts);
    if(cfg.slPct!=null) eff.slPct=cfg.slPct;
    if(cfg.tpPct!=null) eff.tpPct=cfg.tpPct;
    if(cfg.trailPct!=null) eff.trailPct=cfg.trailPct;
    eff.exit = cfg.exit||'fixed';
    eff.carry = !!cfg.carry;
    const mk = (m, err) => ({ i: idx, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params,
      slPct: eff.slPct||0, tpPct: eff.tpPct||0, trailPct: eff.trailPct||0,
      exit: eff.exit, carry: eff.carry, refined: !!refined, m: m, err: err });
    try {
      const dd = getTF(cfg.timeframe);
      eff.sessionMask = eff.carry ? dd.maskCarry : dd.maskIn;
      const sig = E.buildSignals(dd.d, cfg);
      const bt = E.backtest(dd.d, sig.pos, eff);
      return mk(bt.metrics);
    } catch(err){
      errCount++;
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
  const ranked = E.rankResults(results, objective);
  self.postMessage({ type:'done', done:total + refined, total: total + refined, top:ranked.slice(0, topN),
    all:ranked.slice(0, topN), errCount:errCount, refined:refined, passes:pass });
};
