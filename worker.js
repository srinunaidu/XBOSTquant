/* Grid-search Web Worker — loads engine.js via importScripts */
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
  const batch = 25;
  const results = [];
  let errCount = 0;
  // cache resampled bars + session mask per timeframe (built ONCE, reused by all combos)
  const cache = {};
  function getTF(tf){
    if(!cache[tf]){
      const d=E.resample(d1m, tf);
      cache[tf]={d, mask:E.buildSessionMask(d, tradeOpts.sessionStart, tradeOpts.sessionEnd)};
    }
    return cache[tf];
  }
  const total = grid.length;
  for (let i=0;i<total;i++){
    const cfg = grid[i];
    // per-combo stop/target from the grid (falls back to fixed execution opts)
    const eff = Object.assign({}, tradeOpts);
    if(cfg.slPct!=null) eff.slPct=cfg.slPct;
    if(cfg.tpPct!=null) eff.tpPct=cfg.tpPct;
    if(cfg.trailPct!=null) eff.trailPct=cfg.trailPct;
    const mk = (m, err) => ({ i, timeframe: cfg.timeframe, indicator: cfg.indicator, params: cfg.params,
      slPct: eff.slPct||0, tpPct: eff.tpPct||0, trailPct: eff.trailPct||0, m: m, err: err });
    try {
      const {d, mask} = getTF(cfg.timeframe);
      eff.sessionMask = mask;
      const sig = E.buildSignals(d, cfg);
      const bt = E.backtest(d, sig.pos, eff);
      results.push(mk(bt.m));
    } catch(err){
      errCount++;
      results.push(mk({netPnL:0,winRate:0,totalTrades:0,profitFactor:0,maxDD:0,sharpe:-99,sortino:-99,expectancy:0,finalCapital:tradeOpts.capital||100000,tradesPerDay:0,days:0}, String(err)));
    }
    if ((i+1)%batch===0 || i===total-1){
      const ranked = E.rankResults(results, msg.objective).slice(0, msg.topN||200);
      self.postMessage({ type:'progress', done:i+1, total, top:ranked, errCount:errCount,
        current:{ indicator:cfg.indicator, timeframe:cfg.timeframe, params:cfg.params, slPct:eff.slPct||0, tpPct:eff.tpPct||0 } });
    }
  }
  const ranked = E.rankResults(results, msg.objective);
  self.postMessage({ type:'done', done:total, total, top:ranked.slice(0, msg.topN||500), all:ranked.slice(0, msg.topN||500), errCount:errCount });
};
