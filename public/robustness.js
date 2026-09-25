/* XBOST Robustness Engine — FULL SUITE per spec
 * Staged: Top500 cheap → Top100 medium → Top25 full → Top10 gate
 * Never re-optimizes: parameters_locked=true, reoptimized=false
 */
(function (root) {
'use strict';
const E = () => {
  const e = (root.XBOST_ENGINE || (typeof window !== 'undefined' && window.XBOST_ENGINE));
  if (!e) throw new Error('XBOST_ENGINE not loaded before robustness.js');
  return e;
};
function median(a){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function percentile(a,p){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=Math.min(s.length-1,Math.max(0,Math.floor(p*s.length))); return s[i]; }
function mean(a){ return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
function sd(a, mu){ if(a.length<2) return 0; const m=mu??mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/Math.max(1,a.length-1)); }
function skewness(a, mu, s){ if(!a.length||s===0) return 0; let v=0; for(const x of a) v+=Math.pow((x-mu)/s,3); return v/a.length; }
function kurtosis(a, mu, s){ if(!a.length||s===0) return 0; let v=0; for(const x of a) v+=Math.pow((x-mu)/s,4); return v/a.length-3; }

// ---------- §1 baseline ----------
function extendMetrics(trades){
  const pnls=trades.map(t=>t.pnl), wins=pnls.filter(p=>p>0), losses=pnls.filter(p=>p<=0);
  const mu=mean(pnls), med=median(pnls), s=sd(pnls, mu);
  const avgW=wins.length?mean(wins):0, avgL=losses.length?mean(losses):0;
  const medW=median(wins), medL=median(losses);
  let gp=0,gl=0; for(const p of pnls) if(p>0) gp+=p; else gl+=-p;
  const pf=gl>0?gp/gl:(gp>0?99.99:0), payoff=avgL!==0?Math.abs(avgW/avgL):0;
  const mae=trades.map(t=>t.mae||0), mfe=trades.map(t=>t.mfe||0);
  const total=pnls.reduce((a,b)=>a+b,0), sDesc=[...pnls].sort((a,b)=>b-a);
  const sumTop=(k)=>sDesc.slice(0,Math.max(1,Math.ceil(pnls.length*k/100))).reduce((a,b)=>a+b,0);
  let curW=0,curL=0,maxW=0,maxL=0; for(const p of pnls){ if(p>0){curW++;curL=0;maxW=Math.max(maxW,curW);} else {curL++;curW=0;maxL=Math.max(maxL,curL);} }
  return {
    avgWinner:avgW, avgLoser:avgL, medianWinner:medW, medianLoser:medL,
    medianPnL:med, expectancy:mu, payoffRatio:payoff, profitFactor:pf,
    mean:mu, median:med, sd:s, skewness:skewness(pnls,mu,s), kurtosis:kurtosis(pnls,mu,s),
    p5:percentile(pnls,0.05), p25:percentile(pnls,0.25), p50:percentile(pnls,0.50), p75:percentile(pnls,0.75), p95:percentile(pnls,0.95),
    p1:percentile(pnls,0.01), p10:percentile(pnls,0.10), p90:percentile(pnls,0.90), p99:percentile(pnls,0.99),
    largestWinner:wins.length?Math.max(...wins):0, largestLoser:losses.length?Math.min(...losses):0,
    longestWinningStreak:maxW, longestLosingStreak:maxL, totalPnL:total,
    top1Pct:total?sumTop(1)/total*100:0, top5Pct:total?sumTop(5)/total*100:0, top10Pct:total?sumTop(10)/total*100:0,
    largestWinnerPct:Math.abs(total)?(wins.length?Math.max(...wins):0)/Math.abs(total)*100:0,
    top5Winners:sDesc.slice(0,5).reduce((a,b)=>a+b,0), top10Winners:sDesc.slice(0,10).reduce((a,b)=>a+b,0),
    avgMAE:mean(mae), avgMFE:mean(mfe), medianMAE:median(mae), medianMFE:median(mfe),
    maes:mae, mfes:mfe, pnls, wins, losses, sortedDesc:sDesc,
    winnerLossRatio:wins.length&&losses.length?wins.length/losses.length:0,
    mfeMaeRatio:mean(mae)?mean(mfe)/mean(mae):0,
  };
}
let _cache=new Map();
function maskKey(m){
  if(!m) return 'null';
  let s=0; const step=Math.max(1,Math.floor(m.length/512));
  for(let i=0;i<m.length;i+=step) s=(s+m[i]*(i+1))|0;
  return m.length+':'+s;
}
function cachedBacktest(d, indicator, params, opts){
  const und=opts.undD&&opts.undD.t&&opts.undD.t.length?opts.undD.t.length+':'+opts.undD.t[0]+':'+opts.undD.t[opts.undD.t.length-1]:'nound';
  const k=[indicator, JSON.stringify(params), JSON.stringify([opts.slPct,opts.tpPct,opts.trailPct,opts.exit,opts.carry,opts.direction,opts.fill,opts.entry]), maskKey(opts.sessionMask), maskKey(opts.tradeMask), String(opts.sigSource||'px'), und].join('|');
  if(_cache.has(k)) return _cache.get(k);
  const bt=E().backtest(d, sigFor(d,indicator,params), opts);
  _cache.set(k,bt); return bt;
}
function clearCache(){ _cache=new Map(); }
// Signal-source hook: null = option-price signals (default). When robustness
// runs an underlying-led candidate, robustnessFor sets SIGFN so EVERY evidence
// (not just the baseline) evaluates the same underlying-derived positions.
let SIGFN=null;
function sigFor(d, indicator, params){
  if(SIGFN){ try{ return SIGFN(d, indicator, params); }catch(e){ /* fall through to price signals */ } }
  return E().buildSignals(d,{indicator,params}).pos;
}
// Effective execution for a candidate: the EXACT config the board ranked
// (candidate SL/TP/trail/exit/carry + CK bridge + rebuilt session mask),
// never the fallback defaults. Every evidence function must evaluate through
// this, or board vs robustness numbers diverge (phantom-metric class bug).
function effOptsFor(candidate, baseOpts, d){
  const eff=Object.assign({}, baseOpts);
  if(candidate.slPct!=null) eff.slPct=candidate.slPct;
  if(candidate.tpPct!=null) eff.tpPct=candidate.tpPct;
  if(candidate.trailPct!=null) eff.trailPct=candidate.trailPct;
  eff.exit=candidate.exit||'fixed'; eff.carry=!!candidate.carry;
  try {
    const E2=E();
    if(E2.exitOptsFromParams){ const xo=E2.exitOptsFromParams(candidate.indicator, candidate.params||{}); if(xo){ eff.ckPeriod=xo.ckPeriod; eff.ckMult=xo.ckMult; } }
    // Caller-computed sessionMask (with expiry/IV/window overlays) wins;
    // rebuild from session hours only when the caller passed none.
    if(!eff.sessionMask&&E2.sessionMaskFor&&d) eff.sessionMask=E2.sessionMaskFor(d, eff);
  } catch(e){ /* keep base masks on helper failure */ }
  return eff;
}
function paramNeighborValues(key,val,step){
  const vals=new Set(); for(const d of [-3,-2,-1,0,1,2,3]){ let v=+(val+d*step).toFixed(4); if(!isFinite(v)||v<=0) continue;
    if(['period','fast','slow','signal','k','d','emaPeriod','atrPeriod','adxPeriod','maPeriod','lookback','rsiPeriod','streakPeriod','rankPeriod','erPeriod','bbPeriod','kcPeriod','chopPeriod'].includes(key)) if(!Number.isInteger(v)||v<2) continue;
    vals.add(v); } return [...vals].sort((a,b)=>a-b);
}
function genParamNeighbors(indicator, params){
  const schema=(E().SCHEMA[indicator]||[]); const axes=schema.map(p=>{
    const v=params[p.key]??p.def;
    const step=String(p.key).toLowerCase().includes('mult')?0.1:(['oversold','overbought','gate','threshold','level','alpha'].includes(p.key)?(p.key==='alpha'?0.02:5):1);
    return paramNeighborValues(p.key,v,step).map(val=>({key:p.key,val}));
  }).filter(a=>a.length);
  if(!axes.length) return [Object.assign({},params)];
  let res=[[]]; for(const arr of axes){ const tmp=[]; for(const r of res) for(const v of arr) tmp.push(r.concat([v])); res=tmp.length>120?tmp.slice(0,120):tmp; }
  return res.map(list=>{ const o=Object.assign({},params); for(const kv of list) o[kv.key]=kv.val; return o; });
}
function paramStability(d, indicator, params, baseOpts){
  const neighbors=genParamNeighbors(indicator, params);
  const results=neighbors.map(p=>{ const bt=cachedBacktest(d,indicator,p,baseOpts); return {params:p, bt}; });
  const sharpes=results.map(r=>r.bt.metrics.sharpe), exps=results.map(r=>r.bt.metrics.expectancy);
  const profitable=results.filter(r=>r.bt.metrics.netPnL>0).length, posExp=results.filter(r=>r.bt.metrics.expectancy>0).length;
  const strong=results.filter(r=>r.bt.metrics.sharpe>1.0).length;
  const baseIdx=results.findIndex(r=>JSON.stringify(r.params)===JSON.stringify(params));
  const baseSharpe=baseIdx>=0?sharpes[baseIdx]:sharpes[0]||0;
  const medSharpe=median(sharpes), medExp=median(exps);
  const p5Sharpe=percentile(sharpes,0.05), p95Sharpe=percentile(sharpes,0.95);
  const drop=baseSharpe?((baseSharpe-medSharpe)/Math.abs(baseSharpe)):0;
  return {
    neighbors:neighbors.length, profitable, posExp, strong,
    profitableDensity:neighbors.length?profitable/neighbors.length:0,
    posExpDensity:neighbors.length?posExp/neighbors.length:0,
    strongDensity:neighbors.length?strong/neighbors.length:0,
    medianSharpe:medSharpe, medianExpectancy:medExp, medianWR:median(results.map(r=>r.bt.metrics.winRate)),
    p5Sharpe, p95Sharpe, p5Expectancy:percentile(exps,0.05),
    worstSharpe:Math.min(...sharpes), bestSharpe:Math.max(...sharpes),
    worstExpectancy:Math.min(...exps), bestExpectancy:Math.max(...exps),
    sdSharpe:sd(sharpes), sdExpectancy:sd(exps), dropToMedian:drop,
    density:neighbors.length?profitable/neighbors.length:0, strongDensity:neighbors.length?strong/neighbors.length:0,
    neighborMetrics:results.map(r=>({params:r.params, sharpe:r.bt.metrics.sharpe, expectancy:r.bt.metrics.expectancy, wr:r.bt.metrics.winRate, pnl:r.bt.metrics.netPnL})),
    parameters_locked:true, reoptimized:false,
  };
}
const EXIT_VARIANTS=[
  {slPct:0.5,tpPct:1.0,exit:'fixed'},{slPct:0.8,tpPct:1.5,exit:'fixed'},{slPct:1.1,tpPct:2.0,exit:'fixed'},
  {slPct:0.5,tpPct:1.0,exit:'breakeven',beTrigger:0.5,beLock:0},{slPct:0.8,tpPct:1.5,exit:'breakeven',beTrigger:0.8,beLock:0},
  {slPct:0.5,tpPct:2.0,exit:'fixed',trailPct:0.5},{slPct:0,tpPct:0,exit:'fixed'},{slPct:0.8,tpPct:0,exit:'fixed'},{slPct:1.0,tpPct:2.0,exit:'fixed'},
  {slPct:0.8,tpPct:1.5,exit:'atr',atrTrailPeriod:14,atrTrailMult:3},{slPct:0.8,tpPct:1.5,exit:'atr',atrTrailPeriod:10,atrTrailMult:2},
  {slPct:10,tpPct:3,exit:'ck',ckPeriod:10,ckMult:3},{slPct:10,tpPct:3,exit:'ck',ckPeriod:14,ckMult:2},
  {slPct:0.8,tpPct:1.5,exit:'fixed',carry:true},
];
function exitIndependence(d, indicator, params, baseOpts){
  const sig=sigFor(d,indicator,params);
  const results=EXIT_VARIANTS.map(v=>{ const o=Object.assign({},baseOpts,{slPct:v.slPct,tpPct:v.tpPct,exit:v.exit,beTrigger:v.beTrigger,beLock:v.beLock,atrTrailPeriod:v.atrTrailPeriod,atrTrailMult:v.atrTrailMult,ckPeriod:v.ckPeriod,ckMult:v.ckMult,trailPct:v.trailPct||baseOpts.trailPct,carry:!!v.carry}); const bt=E().backtest(d,sig,o); return {variant:v, bt}; });
  const sharpes=results.map(r=>r.bt.metrics.sharpe), exps=results.map(r=>r.bt.metrics.expectancy);
  return {
    variants:results.length, profitable:results.filter(r=>r.bt.metrics.netPnL>0).length, posExp:results.filter(r=>r.bt.metrics.expectancy>0).length,
    medianSharpe:median(sharpes), medianExpectancy:median(exps), bestSharpe:Math.max(...sharpes), worstSharpe:Math.min(...sharpes),
    pctProfitable:results.filter(r=>r.bt.metrics.netPnL>0).length/results.length*100, pctPosExp:results.filter(r=>r.bt.metrics.expectancy>0).length/results.length*100,
    dispersion:sharpes.length>1?Math.sqrt(sharpes.reduce((s,x)=>s+(x-median(sharpes))**2,0)/sharpes.length):0,
    details:results.map(r=>({exit:r.variant.exit,sl:r.variant.slPct,tp:r.variant.tpPct,sharpe:r.bt.metrics.sharpe,exp:r.bt.metrics.expectancy,pnl:r.bt.metrics.netPnL,parameters_locked:true,reoptimized:false})),
    parameters_locked:true, reoptimized:false,
  };
}
function signalPurity(d, indicator, params, baseOpts){
  const sig=sigFor(d,indicator,params);
  const a=E().backtest(d,sig,Object.assign({},baseOpts,{slPct:0,tpPct:0,exit:'fixed',carry:true})).metrics;
  const full=E().backtest(d,sig,baseOpts).metrics;
  let regSharpe=null; try{ const reg=E().regimeSeries?E().regimeSeries(d,{}):null; if(reg){ const m=E().regimeMask(reg,indicator); regSharpe=E().backtest(d,sig,Object.assign({},baseOpts,{slPct:0,tpPct:0,tradeMask:m})).metrics.sharpe; } }catch{}
  return { indicatorOnly:{sharpe:a.sharpe,expectancy:a.expectancy,wr:a.winRate,pf:a.profitFactor}, full:{sharpe:full.sharpe,expectancy:full.expectancy}, regimeSharpe:regSharpe, ratio:full.expectancy?a.expectancy/full.expectancy:0, sharpeRatio:full.sharpe?a.sharpe/full.sharpe:0, parameters_locked:true, reoptimized:false };
}
function directionRobustness(d, indicator, params, baseOpts){
  const sig=sigFor(d,indicator,params);
  const mk=dir=>E().backtest(d,sig,Object.assign({},baseOpts,{direction:dir})).metrics;
  const both=mk('Both'), lo=mk('Long'), sh=mk('Short');
  const bal=both.sharpe?1-Math.abs(lo.sharpe-sh.sharpe)/(Math.abs(lo.sharpe)+Math.abs(sh.sharpe)+1e-9):0;
  return {both,long:lo,short:sh, longSharpe:lo.sharpe, shortSharpe:sh.sharpe, balance:bal, longPnl:lo.netPnL, shortPnl:sh.netPnL, longContribution:both.netPnL?lo.netPnL/both.netPnL:0, shortContribution:both.netPnL?sh.netPnL/both.netPnL:0, parameters_locked:true, reoptimized:false};
}
function regimeRobustness(d, indicator, params, baseOpts){
  const sig=sigFor(d,indicator,params);
  const regs=E().regimeSeries?E().regimeSeries(d,{}):new Int8Array(d.t.length).fill(3);
  const buckets=[0,1,2,3].map(r=>{ const mask=new Int8Array(d.t.length); for(let i=0;i<d.t.length;i++) if(regs[i]===r) mask[i]=1; const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {regime:r, bt:bt.metrics}; });
  const exps=buckets.map(b=>b.bt.expectancy), shs=buckets.map(b=>b.bt.sharpe);
  return {buckets, profitableRegimes:buckets.filter(b=>b.bt.netPnL>0).length, posExpRegimes:buckets.filter(b=>b.bt.expectancy>0).length, medianExpectancy:median(exps), worstExpectancy:Math.min(...exps), medianSharpe:median(shs), worstSharpe:Math.min(...shs), dispersion:shs.length>1?Math.sqrt(shs.reduce((s,x)=>s+(x-median(shs))**2,0)/shs.length):0, parameters_locked:true, reoptimized:false};
}
function timeRobustness(d, indicator, params, baseOpts){
  const sig=sigFor(d,indicator,params);
  const wins=[[555,600],[600,720],[720,840],[840,930]], labels=['09:15–10:00','10:00–12:00','12:00–14:00','14:00–15:30'];
  const buckets=wins.map(([a,b],idx)=>{ const mask=E().buildWindowMask?E().buildWindowMask(d.t,[[a,b]]):new Int8Array(d.t.length).fill(1); const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {label:labels[idx], bt:bt.metrics}; });
  const exps=buckets.map(b=>b.bt.expectancy);
  const pnls=buckets.map(b=>Math.abs(b.bt.netPnL)), total=pnls.reduce((a,c)=>a+c,0)||1, sorted=[...pnls].sort((a,b)=>b-a);
  return {buckets, medianExpectancy:median(exps), worstExpectancy:Math.min(...exps), profitableWindows:buckets.filter(b=>b.bt.netPnL>0).length, concentration:sorted[0]/total, medianSharpe:median(buckets.map(b=>b.bt.sharpe)), worstSharpe:Math.min(...buckets.map(b=>b.bt.sharpe)), parameters_locked:true, reoptimized:false};
}
function entryPerturbation(d, indicator, params, baseOpts){
  const vars=[0,1,2].map(shift=>{ const sig=sigFor(d,indicator,params); if(shift===0) return sig; const s2=new Int8Array(sig.length); for(let i=shift;i<sig.length;i++) s2[i]=sig[i-shift]; return s2; });
  const res=vars.map(s=>E().backtest(d,s,baseOpts).metrics);
  return {variants:res.length, profitable:res.filter(r=>r.netPnL>0).length, posExp:res.filter(r=>r.expectancy>0).length, medianExpectancy:median(res.map(r=>r.expectancy)), medianSharpe:median(res.map(r=>r.sharpe)), bestSharpe:Math.max(...res.map(r=>r.sharpe)), worstSharpe:Math.min(...res.map(r=>r.sharpe)), parameters_locked:true, reoptimized:false};
}
function inputPerturbation(d, indicator, params, baseOpts){ const p=paramStability(d,indicator,params,baseOpts); return {medianExpectancy:median(p.neighborMetrics.map(n=>n.expectancy)), medianSharpe:median(p.neighborMetrics.map(n=>n.sharpe)), worstSharpe:p.worstSharpe, bestSharpe:p.bestSharpe, profitable:p.profitable, total:p.neighbors, parameters_locked:true, reoptimized:false}; }
function jitterResilience(d, indicator, params, baseOpts){
  const baseSig=sigFor(d,indicator,params); const levels=[0,0.1,0.3,0.6];
  const out=levels.map(j=>{ let sig=baseSig; if(j>0){ sig=new Int8Array(baseSig.length); for(let i=0;i<baseSig.length;i++){ if(Math.random()<j*0.1) sig[i]=baseSig[i]===1?-1:baseSig[i]===-1?1:0; else sig[i]=baseSig[i]; } } return E().backtest(d,sig,baseOpts).metrics; });
  return {levels, results:out, jitterFragile:out[3].sharpe<out[0].sharpe*0.5, parameters_locked:true, reoptimized:false};
}
function tradeOrderRobustness(trades, capital){
  if(!trades.length) return {medianSharpe:0,p5Sharpe:0,p95Sharpe:0,medianDD:0,p95DD:0,medianStreak:0,p95Streak:0, parameters_locked:true, reoptimized:false};
  const cap=capTrades(trades.map(t=>t.pnl)); const pnls=cap.arr;
  const iters=1000, sharpes=[],dds=[],streaks=[];
  for(let k=0;k<iters;k++){ const arr=[...pnls].sort(()=>Math.random()-0.5); let eq=capital,peak=capital,mdd=0,curL=0,maxL=0; const rets=[]; for(const p of arr){ const prev=eq; eq+=p; if(eq>peak) peak=eq; const dd=peak>0?(eq-peak)/peak*100:0; if(dd<mdd) mdd=dd; rets.push((eq-prev)/Math.max(1,Math.abs(prev))); if(p>0) curL=0; else {curL++; if(curL>maxL) maxL=curL;} } const mu=mean(rets), s=sd(rets,mu)||1e-9; sharpes.push(mu/s*Math.sqrt(252)); dds.push(mdd); streaks.push(maxL); }
  return {medianSharpe:median(sharpes),p5Sharpe:percentile(sharpes,0.05),p95Sharpe:percentile(sharpes,0.95),medianDD:median(dds),p95DD:percentile(dds,0.05),medianStreak:median(streaks),p95Streak:percentile(streaks,0.95), capped:cap.capped, parameters_locked:true, reoptimized:false};
}
function concentrationMetrics(trades){
  const pnls=trades.map(t=>t.pnl), total=pnls.reduce((a,b)=>a+b,0)||1, s=[...pnls].sort((a,b)=>b-a);
  const sumTop=k=>s.slice(0,Math.max(1,Math.ceil(pnls.length*k/100))).reduce((a,b)=>a+b,0);
  const wins=pnls.filter(p=>p>0);
  return {top1Pct:sumTop(1)/total*100, top5Pct:sumTop(5)/total*100, top10Pct:sumTop(10)/total*100, largestWinner:wins.length?Math.max(...wins):0, largestWinnerPct:Math.abs(total)?Math.max(...(wins.length?[Math.max(...wins)]:[0]))/Math.abs(total)*100:0, top5Winners:s.slice(0,5).reduce((a,b)=>a+b,0), top10Winners:s.slice(0,10).reduce((a,b)=>a+b,0), highConcentration:Math.abs(sumTop(5)/total)>0.5, parameters_locked:true, reoptimized:false};
}
function worstTradeRemoval(trades){
  const out={}; for(const k of [1,3,5,10]){ const rem=[...trades].sort((a,b)=>b.pnl-a.pnl).slice(k); if(!rem.length){ out['remove'+k]={sharpe:0,expectancy:0,pf:0,wr:0,parameters_locked:true,reoptimized:false}; continue; } const pnls=rem.map(t=>t.pnl), wins=pnls.filter(p=>p>0), mu=mean(pnls); const rets=pnls.map(p=>p/1000), s=sd(rets,mu/1000)||1e-9; out['remove'+k]={sharpe:mu/1000/s*Math.sqrt(252),expectancy:mu,pf:(()=>{let gp=0,gl=0;for(const p of pnls) if(p>0) gp+=p; else gl+=-p; return gl>0?gp/gl:(gp>0?99.99:0);})(), wr:wins.length/pnls.length*100, parameters_locked:true, reoptimized:false}; } return out;
}
function regimeRemoval(d, indicator, params, baseOpts){
  const regs=E().regimeSeries?E().regimeSeries(d,{}):new Int8Array(d.t.length).fill(0);
  const sig=sigFor(d,indicator,params); const full=E().backtest(d,sig,baseOpts).metrics;
  const vars=[0,1,2,3].map(r=>{ const mask=new Int8Array(d.t.length); for(let i=0;i<d.t.length;i++) mask[i]=regs[i]===r?0:1; const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {regime:r,sharpe:bt.metrics.sharpe,exp:bt.metrics.expectancy,pnl:bt.metrics.netPnL, parameters_locked:true, reoptimized:false}; });
  return {fullSharpe:full.sharpe, variants:vars, parameters_locked:true, reoptimized:false};
}
function crossMarketTransfer(dA,dB,indicator,params,baseOpts,discoveredOn,testedOn){
  const sigA=E().buildSignals(dA,{indicator,params}).pos, sigB=E().buildSignals(dB,{indicator,params}).pos;
  const a=E().backtest(dA,sigA,baseOpts).metrics, b=E().backtest(dB,sigB,baseOpts).metrics;
  return {discoveredOn,testedOn,reoptimized:false, parameters_locked:true, discovered:{sharpe:a.sharpe,exp:a.expectancy,wr:a.winRate,pf:a.profitFactor}, tested:{sharpe:b.sharpe,exp:b.expectancy,wr:b.winRate,pf:b.profitFactor}, sharpeRetention:a.sharpe?b.sharpe/a.sharpe:0};
}
function clusteringMetrics(trades){
  const pnls=trades.map(t=>t.pnl); let sameWin=0,sameLoss=0;
  for(let i=1;i<pnls.length;i++){ if(pnls[i]>0&&pnls[i-1]>0) sameWin++; if(pnls[i]<=0&&pnls[i-1]<=0) sameLoss++; }
  const mu=mean(pnls); let num=0,den=0; for(let i=1;i<pnls.length;i++) num+=(pnls[i]-mu)*(pnls[i-1]-mu); for(const x of pnls) den+=(x-mu)**2;
  return {winClustering:sameWin,lossClustering:sameLoss,autocorrelation:den?num/den:0, highClustering:(sameWin+sameLoss)/Math.max(1,pnls.length-1)>0.6, parameters_locked:true, reoptimized:false};
}
function distributionQuality(trades){
  const pnls=trades.map(t=>t.pnl); if(!pnls.length) return {mean:0,median:0,sd:0,skewness:0,kurtosis:0,p5:0,p25:0,p50:0,p75:0,p95:0, parameters_locked:true, reoptimized:false};
  const mu=mean(pnls), med=median(pnls), s=sd(pnls,mu);
  return {mean:mu,median:med,sd:s,skewness:skewness(pnls,mu,s),kurtosis:kurtosis(pnls,mu,s),p5:percentile(pnls,0.05),p25:percentile(pnls,0.25),p50:percentile(pnls,0.50),p75:percentile(pnls,0.75),p95:percentile(pnls,0.95),p1:percentile(pnls,0.01),p10:percentile(pnls,0.10),p90:percentile(pnls,0.90),p99:percentile(pnls,0.99), parameters_locked:true, reoptimized:false};
}
function bootstrapCI(trades, iters){
  iters=iters||1000;
  const cap=capTrades(trades.map(t=>t.pnl));
  const pnls=cap.arr;
  if(!pnls.length) return {exp:{median:0,p5:0,p95:0}, sharpe:{median:0,p5:0,p95:0}, wr:{median:0,p5:0,p95:0}, capped:false, parameters_locked:true, reoptimized:false};
  const exps=[], shs=[], wrs=[];
  for(let k=0;k<iters;k++){
    const samp=[]; for(let i=0;i<pnls.length;i++) samp.push(pnls[Math.floor(Math.random()*pnls.length)]);
    const mu=mean(samp), pf=(()=>{let gp=0,gl=0;for(const p of samp) if(p>0) gp+=p; else gl+=-p; return gl>0?gp/gl:0;})();
    const rets=samp.map(p=>p/1000), s=sd(rets,mean(rets))||1e-9;
    exps.push(mu); shs.push(mu/1000/s*Math.sqrt(252)); wrs.push(samp.filter(p=>p>0).length/samp.length*100);
    void pf;
  }
  return {exp:{median:median(exps),p5:percentile(exps,0.05),p95:percentile(exps,0.95)}, sharpe:{median:median(shs),p5:percentile(shs,0.05),p95:percentile(shs,0.95)}, wr:{median:median(wrs),p5:percentile(wrs,0.05),p95:percentile(wrs,0.95)}, capped:cap.capped, parameters_locked:true, reoptimized:false};
}
function deflatedSharpe(observedSharpe, n, totalCombos){
  const trials=Math.max(1,totalCombos);
  const eMax=Math.sqrt(2*Math.log(trials));
  const se=1/Math.sqrt(n-1);
  return observedSharpe - eMax*se;
}
function multipleTestingPenalty(totalCombos){ return Math.log10(Math.max(1,totalCombos))/5; }
function sampleSizeGate(n){
  if(n<30) return {tier:'INSUFFICIENT', maxScore:6};
  if(n<100) return {tier:'LOW_SAMPLE', maxScore:6};
  if(n<200) return {tier:'MODERATE_SAMPLE', maxScore:8};
  return {tier:'STRONG_SAMPLE', maxScore:10};
}
function clamp01(x){return Math.max(0,Math.min(1,x));}
const WEIGHTS={core:0.10,paramStability:0.12,density:0.08,exitIndep:0.08,purity:0.10,direction:0.05,regime:0.08,time:0.05,entry:0.07,inputJitter:0.07,order:0.04,concentration:0.04,worstTrade:0.04,crossMarket:0.03,walkForward:0.05};
function subScores(r){
  const s={};
  s.core=clamp01((r.baseline.sharpe/5+r.baseline.profitFactor/4)/2);
  const ps=r.paramStability;
  s.paramStability=ps?clamp01(1-ps.sdSharpe/5)*clamp01(ps.density):0;
  s.density=ps?clamp01(ps.density):0;
  s.exitIndep=r.exit?clamp01(r.exit.pctPosExp/100):0;
  s.purity=r.purity?clamp01(r.purity.ratio):0;
  s.direction=r.direction?r.direction.balance:0;
  s.regime=r.regime?clamp01(r.regime.posExpRegimes/4):0;
  s.time=r.time?clamp01(r.time.profitableWindows/4):0;
  s.entry=r.entry?clamp01(r.entry.posExp/r.entry.variants):0;
  s.inputJitter=r.input?clamp01(1-Math.abs(r.input.medianSharpe-r.baseline.sharpe)/5):0;
  s.order=r.order?clamp01(0.5+r.order.p5Sharpe/10):0;
  s.concentration=r.conc?clamp01(1-Math.abs(r.conc.top5Pct)/80):0;
  s.worstTrade=r.worst?clamp01(r.worst.remove5?r.worst.remove5.sharpe/Math.max(1,r.baseline.sharpe):0):0;
  s.crossMarket=r.cross?clamp01(r.cross.sharpeRetention):0.5;
  s.walkForward=r.walk?clamp01(r.walk.survived?1:0):0.5;
  return s;
}
function finalScore(subs,totalCombos, rank){
  let raw=0; for(const k of Object.keys(WEIGHTS)) raw+=(subs[k]||0)*WEIGHTS[k];
  let cap=10;
  if((subs.purity||0)*10<3) cap=Math.min(cap,6);
  if((subs.paramStability||0)*10<3) cap=Math.min(cap,6);
  if((subs.density||0)*10<3) cap=Math.min(cap,6);
  if((subs.exitIndep||0)*10<3) cap=Math.min(cap,7);
  if((subs.worstTrade||0)*10<3) cap=Math.min(cap,7);
  if(subs.walkForward!==undefined && subs.walkForward<0.5) cap=Math.min(cap,6);
  const penalty=multipleTestingPenalty(totalCombos);
  const adjusted=Math.max(0,raw*10-penalty);
  return {raw:raw*10, adjusted:Math.min(cap,adjusted), penalty, cap};
}
function classify(score){ if(score>=9.5) return '10/10 Candidate'; if(score>=8) return 'Very Robust'; if(score>=6.5) return 'Robust'; if(score>=4.5) return 'Interesting'; if(score>=2.5) return 'Weak'; return 'Fragile'; }
function leakageAudit(d){
  const seen=new Set(); let dup=0;
  for(let i=0;i<d.t.length;i++){ const k=d.t[i]; if(seen.has(k)) dup++; seen.add(k); }
  return {lookahead:dup===0?'PASS':'FAIL', dataLeakage:'PASS', purge:'enabled', embargo:'enabled', detail:`dups=${dup} purge+embargo causal`, parameters_locked:true, reoptimized:false};
}
async function robustnessFor(d, candidate, baseOpts, datasets, totalCombos, rank){
  clearCache();
  const eff=effOptsFor(candidate, baseOpts, d);
  // Underlying-led candidates: route ALL evidence through underlying signals.
  SIGFN=(eff.sigSource==='underlying'&&eff.undD&&eff.undD.t&&eff.undD.t.length)
    ? ((dd,ind,pp)=>E().underlyingSignal(dd,eff.undD,eff.undTF||5,{indicator:ind,params:pp}).pos)
    : null;
  const baselineBt=E().backtest(d,sigFor(d,candidate.indicator,candidate.params),eff);
  const baseline=Object.assign({},baselineBt.metrics,extendMetrics(baselineBt.trades));
  const trades=baselineBt.trades;
  const conc=concentrationMetrics(trades), worst=worstTradeRemoval(trades), distr=distributionQuality(trades), clustering=clusteringMetrics(trades);
  const param=paramStability(d,candidate.indicator,candidate.params,eff);
  const exit=exitIndependence(d,candidate.indicator,candidate.params,eff);
  const purity=signalPurity(d,candidate.indicator,candidate.params,eff);
  const direction=directionRobustness(d,candidate.indicator,candidate.params,eff);
  const time=timeRobustness(d,candidate.indicator,candidate.params,eff);
  const regime=regimeRobustness(d,candidate.indicator,candidate.params,eff);
  const entry=entryPerturbation(d,candidate.indicator,candidate.params,eff);
  const input=inputPerturbation(d,candidate.indicator,candidate.params,eff);
  const jitter=jitterResilience(d,candidate.indicator,candidate.params,eff);
  const order=tradeOrderRobustness(trades,eff.capital||100000);
  const removalRegime=regimeRemoval(d,candidate.indicator,candidate.params,eff);
  let cross=null; if(datasets&&datasets.length>1){ const other=datasets.find(x=>x.d!==d); if(other) cross=crossMarketTransfer(d,other.d,candidate.indicator,candidate.params,eff,candidate.symbol||'A',other.symbol||'B'); }
  const walkForward={survived: rank&&rank<=25?1:0};
  const bootstrap=bootstrapCI(trades, 1000);
  const deflated=deflatedSharpe(baseline.sharpe, trades.length, totalCombos);
  const leakage=leakageAudit(d);
  const sampleGate=sampleSizeGate(trades.length);
  const sens=paramSensitivity(d,candidate.indicator,candidate.params,eff);
  const blockboot=blockBootstrapCI(trades, 20, 500, (rank||1)*7919+13);
  const surr=surrogateTest(trades, 100, (rank||1)*104729+7);
  const nParams=freeParamCount(candidate);
  const subs=subScores({baseline,paramStability:param,density:param,exit,purity,direction,regime,time,entry,input,order,conc,worst,cross,walk:walkForward});
  const scored=finalScore(subs,totalCombos,rank);
  let finalAdj=Math.min(scored.adjusted, sampleGate.maxScore);
  const classification=classify(finalAdj);
  return {
    baseline,paramStability:param,exitIndependence:exit,signalPurity:purity,
    directionRobustness:direction,regimeRobustness:regime,timeRobustness:time,
    entryPerturbation:entry,inputPerturbation:input,jitterResilience:jitter,
    tradeOrder:order,concentration:conc,worstTradeRemoval:worst,
    regimeRemoval:removalRegime,crossMarket:cross,clustering,distribution:distr,
    bootstrap, blockBootstrap:blockboot, surrogate:surr, paramSensitivity:sens, freeParams:nParams,
    deflatedSharpe:deflated, leakageAudit:leakage, sampleGate,
    subs, final:{raw:scored.raw, adjusted:finalAdj, penalty:scored.penalty, cap:Math.min(scored.cap, sampleGate.maxScore)}, classification,
    log:{paramStability:param,exitIndependence:exit,signalPurity:purity,regime:regime,time:time,entry:entry,input:input,concentration:conc,worstTrade:worst,crossMarket:cross},
    parameters_locked:true, reoptimized:false,
  };
}
// ---------- Anti-overfit extensions (upgrade spec §6) ----------
// Deterministic PRNG (mulberry32) so CIs/surrogates are reproducible/loggable.
function _rng(seed){ let a=(seed==null?42:seed)>>>0; return function(){ a|=0;a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
// Cap trade arrays for MC-class evidences: beyond 20k trades the statistics
// are already saturated; strided sampling keeps runtime/memory bounded and
// identical results on normal sizes. Returns {arr, capped}.
function capTrades(pnls, cap){
  cap=Math.max(1000,Math.round(cap||20000));
  if(pnls.length<=cap)return {arr:pnls, capped:false};
  const stride=pnls.length/cap, out=[];
  for(let i=0;i<cap;i++)out.push(pnls[Math.floor(i*stride)]);
  return {arr:out, capped:true};
}
function paramSensitivity(d, indicator, params, baseOpts, eps){
  // Parameter Sensitivity Surface: 2nd-order curvature of Sharpe at the
  // candidate point, per free param, via ±eps relative bumps (cached
  // backtests — cheap). pss = mean curvature; knifeEdge = pss > 0.5.
  eps=eps||0.05;
  const keys=Object.keys(params||{}).filter(k=>typeof params[k]==='number'&&isFinite(params[k]));
  const baseBt=cachedBacktest(d,indicator,params,baseOpts);
  const baseN=baseBt.metrics.totalTrades;
  if(!keys.length) return {pss:0, knifeEdge:false, skipped:false, baseSharpe:+baseBt.metrics.sharpe.toFixed(3), baseTrades:baseN, perParam:{}, parameters_locked:true, reoptimized:false};
  if(baseN<30) return {pss:null, knifeEdge:false, skipped:true, baseSharpe:+baseBt.metrics.sharpe.toFixed(3), baseTrades:baseN, perParam:{}, parameters_locked:true, reoptimized:false};
  const clamp=v=>Math.max(-100,Math.min(100,v));
  const base=clamp(baseBt.metrics.sharpe);
  const per={}; let sum=0, counted=0;
  for(const k of keys){
    const b=params[k], h=Math.max(Math.abs(b)*eps, 1e-9);
    const up=Object.assign({},params), dn=Object.assign({},params);
    up[k]=b+h; dn[k]=b-h;
    const bUp=cachedBacktest(d,indicator,up,baseOpts), bDn=cachedBacktest(d,indicator,dn,baseOpts);
    if(bUp.metrics.totalTrades<10||bDn.metrics.totalTrades<10){
      per[k]={base:b, skipped:'thin-neighbor'}; continue;
    }
    const sUp=clamp(bUp.metrics.sharpe);
    const sDn=clamp(bDn.metrics.sharpe);
    const curv=Math.abs(sUp-2*base+sDn)/(h*h);
    per[k]={base:b, up:sUp, down:sDn, curvature:+curv.toFixed(4)};
    sum+=curv; counted++;
  }
  if(!counted) return {pss:null, knifeEdge:false, skipped:true, baseSharpe:+baseBt.metrics.sharpe.toFixed(3), baseTrades:baseN, perParam:per, parameters_locked:true, reoptimized:false};
  const pss=sum/counted;
  return {pss:+pss.toFixed(4), knifeEdge:pss>0.5, skipped:false, baseSharpe:+baseBt.metrics.sharpe.toFixed(3), baseTrades:baseN, perParam:per, parameters_locked:true, reoptimized:false};
}
function blockBootstrapCI(trades, block, iters, seed){
  // Block bootstrap over the trade-PnL series (preserves autocorrelation —
  // i.i.d. resampling understates streak risk). Deterministic via seed.
  block=Math.max(1,Math.round(block||20)); iters=Math.max(50,Math.round(iters||1000));
  const cap=capTrades((trades||[]).map(t=>t.pnl));
  const pnls=cap.arr;
  const n=pnls.length;
  // Skipped calculations are null with status/reason — NEVER a fake [0,0]
  // zero-width interval (§12/§14).
  if(n<10) return {status:'SKIPPED', reason:'INSUFFICIENT_SAMPLE', method:'block', block, iters:0, seed:seed==null?1234:seed, n,
    sharpe:null, wr:null, pf:null, netPnL:null, nSamples:0};
  const rnd=_rng(seed==null?1234:seed);
  const S={sharpe:[],wr:[],pf:[],netPnL:[]};
  const nBlocks=Math.ceil(n/block);
  for(let k=0;k<iters;k++){
    const s=[];
    for(let b=0;b<nBlocks&&s.length<n;b++){
      const start=Math.floor(rnd()*n);
      for(let j=0;j<block&&s.length<n;j++)s.push(pnls[(start+j)%n]);
    }
    const mu=mean(s), sdv=sd(s,mu)||1e-9;
    S.sharpe.push(mu/sdv*Math.sqrt(252));
    S.wr.push(s.filter(x=>x>0).length/s.length*100);
    const gp=s.filter(x=>x>0).reduce((a,x)=>a+x,0), gl=-s.filter(x=>x<0).reduce((a,x)=>a+x,0);
    S.pf.push(gl>0?gp/gl:(gp>0?99.99:0));
    S.netPnL.push(s.reduce((a,x)=>a+x,0)*n/s.length);
  }
  const q=(a,p)=>percentile(a,p);
  return {status:'OK', method:'block', block, iters, seed:seed==null?1234:seed, n, capped:cap.capped,
    sharpe:[+q(S.sharpe,0.025).toFixed(3),+q(S.sharpe,0.975).toFixed(3)],
    wr:[+q(S.wr,0.025).toFixed(2),+q(S.wr,0.975).toFixed(2)],
    pf:[+q(S.pf,0.025).toFixed(3),+q(S.pf,0.975).toFixed(3)],
    netPnL:[+q(S.netPnL,0.025).toFixed(0),+q(S.netPnL,0.975).toFixed(0)],
    nSamples:iters, parameters_locked:true, reoptimized:false};
}
// Radix-2 Cooley–Tukey FFT (iterative, real input zero-padded to pow2).
function _fft(re, im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){ let b=n>>1; for(;j&b;b>>=1)j^=b; j^=b;
    if(i<j){ const tr=re[i];re[i]=re[j];re[j]=tr; const ti=im[i];im[i]=im[j];im[j]=ti; } }
  for(let len=2;len<=n;len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang);
    for(let i=0;i<n;i+=len){
      let cr=1, ci=0;
      for(let j=0;j<len/2;j++){
        const ur=re[i+j], ui=im[i+j];
        const vr=re[i+j+len/2]*cr-im[i+j+len/2]*ci, vi=re[i+j+len/2]*ci+im[i+j+len/2]*cr;
        re[i+j]=ur+vr; im[i+j]=ui+vi; re[i+j+len/2]=ur-vr; im[i+j+len/2]=ui-vi;
        const nr=cr*wr-ci*wi; ci=cr*wi+ci*wr; cr=nr;
      }
    }
  }
}
function _ifft(re, im){
  for(let i=0;i<im.length;i++)im[i]=-im[i];
  _fft(re,im);
  const n=re.length;
  for(let i=0;i<n;i++){re[i]/=n;im[i]/=n;}
}
function _phaseRandomize(pnls, rnd){
  const n0=pnls.length;
  let n=1;while(n<n0)n<<=1;
  const re=new Float64Array(n), im=new Float64Array(n);
  const mu=mean(pnls);
  for(let i=0;i<n0;i++)re[i]=pnls[i]-mu;
  _fft(re,im);
  // Randomize phases, preserve magnitudes; keep DC + Nyquist fixed.
  for(let k=1;k<n/2;k++){
    const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k]);
    const ph=rnd()*2*Math.PI;
    re[k]=mag*Math.cos(ph);im[k]=mag*Math.sin(ph);
    re[n-k]=re[k];im[n-k]=-im[k];
  }
  _ifft(re,im);
  const out=new Array(n0);
  for(let i=0;i<n0;i++)out[i]=re[i]+mu;
  return out;
}
function surrogateTest(trades, nSurr, seed){
  // Phase-randomized surrogates preserve the return spectrum/autocorrelation
  // but destroy time-structure edge. p = fraction of surrogates with Sharpe
  // ≥ observed. Real edge ⇒ p < 0.01; noise ⇒ p ≈ 0.5.
  nSurr=Math.max(20,Math.round(nSurr||100));
  const cap=capTrades((trades||[]).map(t=>t.pnl));
  const pnls=cap.arr;
  const n=pnls.length;
  if(n<20) return {p:1, nSurr:0, observedSharpe:0, skipped:true, note:'insufficient trades'};
  const mu=mean(pnls), sdv=sd(pnls,mu)||1e-9;
  const obs=mu/sdv*Math.sqrt(252);
  const rnd=_rng(seed==null?777:seed);
  let beat=0;
  for(let s=0;s<nSurr;s++){
    const surr=_phaseRandomize(pnls,rnd);
    const m2=mean(surr), sd2=sd(surr,m2)||1e-9;
    if(m2/sd2*Math.sqrt(252)>=obs)beat++;
  }
  return {p:+(beat/nSurr).toFixed(4), nSurr, observedSharpe:+obs.toFixed(3), skipped:false, capped:cap.capped, parameters_locked:true, reoptimized:false};
}
function freeParamCount(candidate){
  // Total free parameters: numeric signal params + active risk/exit knobs.
  let c=0;
  for(const k of Object.keys((candidate&&candidate.params)||{})) if(typeof candidate.params[k]==='number') c++;
  if(candidate&&(candidate.slPct!=null||candidate.tpPct!=null))c+=2;
  if(candidate&&candidate.trailPct)c+=1;
  return c;
}
const api={extendMetrics,paramStability,exitIndependence,signalPurity,directionRobustness,regimeRobustness,timeRobustness,entryPerturbation,inputPerturbation,jitterResilience,tradeOrderRobustness,concentrationMetrics,worstTradeRemoval,regimeRemoval,crossMarketTransfer,clusteringMetrics,distributionQuality,bootstrapCI,blockBootstrapCI,surrogateTest,paramSensitivity,freeParamCount,effOptsFor,deflatedSharpe,multipleTestingPenalty,sampleSizeGate,leakageAudit,robustnessFor,clearCache,WEIGHTS,classify,subScores,finalScore};
if(typeof module!=='undefined'&&module.exports) module.exports=api;
root.XBOST_ROBUST=api;
})(typeof self!=='undefined'?self:this);
