/* XBOST Robustness Engine v2 — INDICATOR & COMBINATION layer (isolation from execution).
 * Implements spec §§1-27: staged, cached, never re-optimizes (§27/28).
 * Public: window.XBOST_ROBUST (worker: self.XBOST_ROBUST). */
(function (root) {
'use strict';
const E = () => {
  const e = (root.XBOST_ENGINE || (typeof window !== 'undefined' && window.XBOST_ENGINE));
  if (!e) throw new Error('XBOST_ENGINE not loaded before robustness.js');
  return e;
};

// ---------- utils ----------
function median(a){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function percentile(a,p){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=Math.min(s.length-1,Math.max(0,Math.floor(p*s.length))); return s[i]; }
function mean(a){ return a.length?a.reduce((x,y)=>x+y,0)/a.length:0; }
function sd(a, mu){ if(a.length<2) return 0; const m=mu??mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function skewness(a, mu, s){ if(!a.length||s===0) return 0; let v=0; for(const x of a) v+=Math.pow((x-mu)/s,3); return v/a.length; }
function kurtosis(a, mu, s){ if(!a.length||s===0) return 0; let v=0; for(const x of a) v+=Math.pow((x-mu)/s,4); return v/a.length-3; }

// ---------- §1 baseline extension ----------
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
    largestWinner:wins.length?Math.max(...wins):0, largestLoser:losses.length?Math.min(...losses):0,
    longestWinningStreak:maxW, longestLosingStreak:maxL, totalPnL:total,
    top1Pct:(total?sumTop(1)/total*100:0), top5Pct:(total?sumTop(5)/total*100:0), top10Pct:(total?sumTop(10)/total*100:0),
    largestWinnerPct:Math.abs(total)?Math.max(...(wins.length?[Math.max(...wins)]:[0]))/Math.abs(total)*100:0,
    avgMAE:mean(mae), avgMFE:mean(mfe), medianMAE:median(mae), medianMFE:median(mfe),
    maes:mae, mfes:mfe, pnls, wins, losses, sortedDesc:sDesc,
  };
}

// ---------- cache ----------
let _cache=new Map();
function cachedBacktest(d, indicator, params, opts){
  const k=[indicator, JSON.stringify(params), JSON.stringify([opts.slPct,opts.tpPct,opts.exit,opts.carry,opts.direction,opts.fill,opts.entry])].join('|');
  if(_cache.has(k)) return _cache.get(k);
  const bt=E().backtest(d, E().buildSignals(d,{indicator,params}).pos, opts);
  _cache.set(k,bt); return bt;
}
function clearCache(){ _cache=new Map(); }
function paramNeighborValues(key,val,step){
  const vals=new Set(); for(const d of [-2,-1,0,1,2]){ let v=+(val+d*step).toFixed(4); if(!isFinite(v)||v<=0) continue;
    if(['period','fast','slow','signal','k','d','emaPeriod','atrPeriod','adxPeriod','maPeriod','lookback','rsiPeriod','streakPeriod','rankPeriod','erPeriod','bbPeriod','kcPeriod'].includes(key)) if(!Number.isInteger(v)||v<2) continue;
    vals.add(v); } return [...vals].sort((a,b)=>a-b);
}
function genParamNeighbors(indicator, params){
  const schema=(E().SCHEMA[indicator]||[]); const axes=schema.map(p=>{
    const v=params[p.key]??p.def;
    const step=String(p.key).toLowerCase().includes('mult')?0.2:(['oversold','overbought','gate','threshold','level'].includes(p.key)?5:(p.key==='alpha'?0.02:1));
    return paramNeighborValues(p.key,v,step).map(val=>({key:p.key,val}));
  }).filter(a=>a.length);
  if(!axes.length) return [Object.assign({},params)];
  let res=[[]]; for(const arr of axes){ const tmp=[]; for(const r of res) for(const v of arr) tmp.push(r.concat([v])); res=tmp.length>80?tmp.slice(0,80):tmp; }
  return res.map(list=>{ const o=Object.assign({},params); for(const kv of list) o[kv.key]=kv.val; return o; });
}

// ---------- §2 param stability + §3 density ----------
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
  const sig=E().buildSignals(d,{indicator,params}).pos;
  const results=EXIT_VARIANTS.map(v=>{ const o=Object.assign({},baseOpts,{slPct:v.slPct,tpPct:v.tpPct,exit:v.exit,beTrigger:v.beTrigger,beLock:v.beLock,atrTrailPeriod:v.atrTrailPeriod,atrTrailMult:v.atrTrailMult,ckPeriod:v.ckPeriod,ckMult:v.ckMult,trailPct:v.trailPct||baseOpts.trailPct,carry:!!v.carry}); const bt=E().backtest(d,sig,o); return {variant:v, bt}; });
  const sharpes=results.map(r=>r.bt.metrics.sharpe), exps=results.map(r=>r.bt.metrics.expectancy);
  return {
    variants:results.length, profitable:results.filter(r=>r.bt.metrics.netPnL>0).length, posExp:results.filter(r=>r.bt.metrics.expectancy>0).length,
    medianSharpe:median(sharpes), medianExpectancy:median(exps), bestSharpe:Math.max(...sharpes), worstSharpe:Math.min(...sharpes),
    pctProfitable:results.filter(r=>r.bt.metrics.netPnL>0).length/results.length*100, pctPosExp:results.filter(r=>r.bt.metrics.expectancy>0).length/results.length*100,
    dispersion:sharpes.length>1?Math.sqrt(sharpes.reduce((s,x)=>s+(x-median(sharpes))**2,0)/sharpes.length):0,
    details:results.map(r=>({exit:r.variant.exit,sl:r.variant.slPct,tp:r.variant.tpPct,sharpe:r.bt.metrics.sharpe,exp:r.bt.metrics.expectancy,pnl:r.bt.metrics.netPnL})),
  };
}
function signalPurity(d, indicator, params, baseOpts){
  const sig=E().buildSignals(d,{indicator,params}).pos;
  const a=E().backtest(d,sig,Object.assign({},baseOpts,{slPct:0,tpPct:0,exit:'fixed',carry:true})).metrics;
  const full=E().backtest(d,sig,baseOpts).metrics;
  let regSharpe=null; try{ const reg=E().regimeSeries?E().regimeSeries(d,{}):null; if(reg){ const m=E().regimeMask(reg,indicator); regSharpe=E().backtest(d,sig,Object.assign({},baseOpts,{slPct:0,tpPct:0,tradeMask:m})).metrics.sharpe; } }catch{}
  return { indicatorOnly:{sharpe:a.sharpe,expectancy:a.expectancy,wr:a.winRate,pf:a.profitFactor}, full:{sharpe:full.sharpe,expectancy:full.expectancy}, regimeSharpe:regSharpe, ratio:full.expectancy?a.expectancy/full.expectancy:0, sharpeRatio:full.sharpe?a.sharpe/full.sharpe:0 };
}
function directionRobustness(d, indicator, params, baseOpts){
  const sig=E().buildSignals(d,{indicator,params}).pos;
  const mk=dir=>E().backtest(d,sig,Object.assign({},baseOpts,{direction:dir})).metrics;
  const both=mk('Both'), lo=mk('Long'), sh=mk('Short');
  const bal=both.sharpe?1-Math.abs(lo.sharpe-sh.sharpe)/(Math.abs(lo.sharpe)+Math.abs(sh.sharpe)+1e-9):0;
  return {both,long:lo,short:sh, longSharpe:lo.sharpe, shortSharpe:sh.sharpe, balance:bal, longPnl:lo.netPnL, shortPnl:sh.netPnL};
}
function regimeRobustness(d, indicator, params, baseOpts){
  const sig=E().buildSignals(d,{indicator,params}).pos;
  const regs=E().regimeSeries?E().regimeSeries(d,{}):new Int8Array(d.t.length).fill(3);
  const buckets=[0,1,2,3].map(r=>{ const mask=new Int8Array(d.t.length); for(let i=0;i<d.t.length;i++) if(regs[i]===r) mask[i]=1; const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {regime:r, bt:bt.metrics}; });
  const exps=buckets.map(b=>b.bt.expectancy), shs=buckets.map(b=>b.bt.sharpe);
  return {buckets, profitableRegimes:buckets.filter(b=>b.bt.netPnL>0).length, posExpRegimes:buckets.filter(b=>b.bt.expectancy>0).length, medianExpectancy:median(exps), worstExpectancy:Math.min(...exps), medianSharpe:median(shs), worstSharpe:Math.min(...shs), dispersion:shs.length>1?Math.sqrt(shs.reduce((s,x)=>s+(x-median(shs))**2,0)/shs.length):0};
}
function timeRobustness(d, indicator, params, baseOpts){
  const sig=E().buildSignals(d,{indicator,params}).pos;
  const wins=[[555,600],[600,720],[720,840],[840,930]], labels=['09:15–10:00','10:00–12:00','12:00–14:00','14:00–15:30'];
  const buckets=wins.map(([a,b],idx)=>{ const mask=E().buildWindowMask?E().buildWindowMask(d.t,[[a,b]]):new Int8Array(d.t.length).fill(1); const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {label:labels[idx], bt:bt.metrics}; });
  const exps=buckets.map(b=>b.bt.expectancy);
  const pnls=buckets.map(b=>Math.abs(b.bt.netPnL)), total=pnls.reduce((a,c)=>a+c,0)||1, sorted=[...pnls].sort((a,b)=>b-a);
  return {buckets, medianExpectancy:median(exps), worstExpectancy:Math.min(...exps), profitableWindows:buckets.filter(b=>b.bt.netPnL>0).length, concentration:sorted[0]/total, medianSharpe:median(buckets.map(b=>b.bt.sharpe)), worstSharpe:Math.min(...buckets.map(b=>b.bt.sharpe))};
}
function entryPerturbation(d, indicator, params, baseOpts){
  const vars=[0,1,2].map(shift=>{ const sig=E().buildSignals(d,{indicator,params}).pos; if(shift===0) return sig; const s2=new Int8Array(sig.length); for(let i=shift;i<sig.length;i++) s2[i]=sig[i-shift]; return s2; });
  const res=vars.map(s=>E().backtest(d,s,baseOpts).metrics);
  return {variants:res.length, profitable:res.filter(r=>r.netPnL>0).length, posExp:res.filter(r=>r.expectancy>0).length, medianExpectancy:median(res.map(r=>r.expectancy)), medianSharpe:median(res.map(r=>r.sharpe)), bestSharpe:Math.max(...res.map(r=>r.sharpe)), worstSharpe:Math.min(...res.map(r=>r.sharpe))};
}
function inputPerturbation(d, indicator, params, baseOpts){ const p=paramStability(d,indicator,params,baseOpts); return {medianExpectancy:median(p.neighborMetrics.map(n=>n.expectancy)), medianSharpe:median(p.neighborMetrics.map(n=>n.sharpe)), worstSharpe:p.worstSharpe, bestSharpe:p.bestSharpe, profitable:p.profitable, total:p.neighbors}; }
function jitterResilience(d, indicator, params, baseOpts){
  const baseSig=E().buildSignals(d,{indicator,params}).pos; const levels=[0,0.1,0.3,0.6];
  const out=levels.map(j=>{ let sig=baseSig; if(j>0){ sig=new Int8Array(baseSig.length); for(let i=0;i<baseSig.length;i++){ if(Math.random()<j*0.1) sig[i]=baseSig[i]===1?-1:baseSig[i]===-1?1:0; else sig[i]=baseSig[i]; } } return E().backtest(d,sig,baseOpts).metrics; });
  return {levels, results:out};
}
function tradeOrderRobustness(trades, capital){
  if(!trades.length) return {medianSharpe:0,p5Sharpe:0,p95Sharpe:0,medianDD:0,p95DD:0,medianStreak:0,p95Streak:0};
  const pnls=trades.map(t=>t.pnl); const iters=1000, sharpes=[],dds=[],streaks=[];
  for(let k=0;k<iters;k++){ const arr=[...pnls].sort(()=>Math.random()-0.5); let eq=capital,peak=capital,mdd=0,curL=0,maxL=0; const rets=[]; for(const p of arr){ const prev=eq; eq+=p; if(eq>peak) peak=eq; const dd=peak>0?(eq-peak)/peak*100:0; if(dd<mdd) mdd=dd; rets.push((eq-prev)/Math.max(1,Math.abs(prev))); if(p>0) curL=0; else {curL++; if(curL>maxL) maxL=curL;} } const mu=mean(rets), s=sd(rets,mu)||1e-9; sharpes.push(mu/s*Math.sqrt(252)); dds.push(mdd); streaks.push(maxL); }
  return {medianSharpe:median(sharpes),p5Sharpe:percentile(sharpes,0.05),p95Sharpe:percentile(sharpes,0.95),medianDD:median(dds),p95DD:percentile(dds,0.05),medianStreak:median(streaks),p95Streak:percentile(streaks,0.95)};
}
function concentrationMetrics(trades){
  const pnls=trades.map(t=>t.pnl), total=pnls.reduce((a,b)=>a+b,0)||1, s=[...pnls].sort((a,b)=>b-a);
  const sumTop=k=>s.slice(0,Math.max(1,Math.ceil(pnls.length*k/100))).reduce((a,b)=>a+b,0);
  const wins=pnls.filter(p=>p>0);
  return {top1Pct:sumTop(1)/total*100, top5Pct:sumTop(5)/total*100, top10Pct:sumTop(10)/total*100, largestWinner:wins.length?Math.max(...wins):0, largestWinnerPct:Math.abs(total)?Math.max(...(wins.length?[Math.max(...wins)]:[0]))/Math.abs(total)*100:0, top5Winners:s.slice(0,5).reduce((a,b)=>a+b,0), top10Winners:s.slice(0,10).reduce((a,b)=>a+b,0)};
}
function worstTradeRemoval(trades){
  const out={}; for(const k of [1,3,5,10]){ const rem=[...trades].sort((a,b)=>b.pnl-a.pnl).slice(k); if(!rem.length){ out['remove'+k]={sharpe:0,expectancy:0,pf:0,wr:0}; continue; } const pnls=rem.map(t=>t.pnl), wins=pnls.filter(p=>p>0), mu=mean(pnls); const rets=pnls.map(p=>p/1000), s=sd(rets,mu/1000)||1e-9; out['remove'+k]={sharpe:mu/1000/s*Math.sqrt(252),expectancy:mu,pf:(()=>{let gp=0,gl=0;for(const p of pnls) if(p>0) gp+=p; else gl+=-p; return gl>0?gp/gl:(gp>0?99.99:0);})(), wr:wins.length/pnls.length*100}; } return out;
}
function regimeRemoval(d, indicator, params, baseOpts){
  const regs=E().regimeSeries?E().regimeSeries(d,{}):new Int8Array(d.t.length).fill(0);
  const sig=E().buildSignals(d,{indicator,params}).pos; const full=E().backtest(d,sig,baseOpts).metrics;
  const vars=[0,1,2,3].map(r=>{ const mask=new Int8Array(d.t.length); for(let i=0;i<d.t.length;i++) mask[i]=regs[i]===r?0:1; const bt=E().backtest(d,sig,Object.assign({},baseOpts,{tradeMask:mask})); return {regime:r,sharpe:bt.metrics.sharpe,exp:bt.metrics.expectancy,pnl:bt.metrics.netPnL}; });
  return {fullSharpe:full.sharpe, variants:vars};
}
function crossMarketTransfer(dA,dB,indicator,params,baseOpts,discoveredOn,testedOn){
  const sigA=E().buildSignals(dA,{indicator,params}).pos, sigB=E().buildSignals(dB,{indicator,params}).pos;
  const a=E().backtest(dA,sigA,baseOpts).metrics, b=E().backtest(dB,sigB,baseOpts).metrics;
  return {discoveredOn,testedOn,reoptimized:false, discovered:{sharpe:a.sharpe,exp:a.expectancy,wr:a.winRate,pf:a.profitFactor}, tested:{sharpe:b.sharpe,exp:b.expectancy,wr:b.winRate,pf:b.profitFactor}, sharpeRetention:a.sharpe?b.sharpe/a.sharpe:0};
}
function clusteringMetrics(trades){
  const pnls=trades.map(t=>t.pnl); let sameWin=0,sameLoss=0;
  for(let i=1;i<pnls.length;i++){ if(pnls[i]>0&&pnls[i-1]>0) sameWin++; if(pnls[i]<=0&&pnls[i-1]<=0) sameLoss++; }
  const mu=mean(pnls); let num=0,den=0; for(let i=1;i<pnls.length;i++) num+=(pnls[i]-mu)*(pnls[i-1]-mu); for(const x of pnls) den+=(x-mu)**2;
  return {winClustering:sameWin,lossClustering:sameLoss,autocorrelation:den?num/den:0, highClustering:(sameWin+sameLoss)/Math.max(1,pnls.length-1)>0.6};
}
function distributionQuality(trades){
  const pnls=trades.map(t=>t.pnl); if(!pnls.length) return {mean:0,median:0,sd:0,skewness:0,kurtosis:0,p5:0,p25:0,p50:0,p75:0,p95:0};
  const mu=mean(pnls), med=median(pnls), s=sd(pnls,mu);
  return {mean:mu,median:med,sd:s,skewness:skewness(pnls,mu,s),kurtosis:kurtosis(pnls,mu,s),p5:percentile(pnls,0.05),p25:percentile(pnls,0.25),p50:percentile(pnls,0.50),p75:percentile(pnls,0.75),p95:percentile(pnls,0.95)};
}
function clamp01(x){return Math.max(0,Math.min(1,x));}
const WEIGHTS={core:0.15,paramStability:0.15,density:0.10,exitIndep:0.10,purity:0.10,direction:0.05,regime:0.10,time:0.05,entry:0.05,inputJitter:0.05,order:0.05,concentration:0.05,worstTrade:0.05,crossMarket:0.05};
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
  return s;
}
function finalScore(subs,totalCombos){
  let raw=0; for(const k of Object.keys(WEIGHTS)) raw+=(subs[k]||0)*WEIGHTS[k];
  let cap=10;
  if((subs.purity||0)*10<3) cap=Math.min(cap,6);
  if((subs.paramStability||0)*10<3) cap=Math.min(cap,6);
  if((subs.density||0)*10<3) cap=Math.min(cap,6);
  if((subs.exitIndep||0)*10<3) cap=Math.min(cap,7);
  if((subs.worstTrade||0)*10<3) cap=Math.min(cap,7);
  const penalty=Math.log10(Math.max(1,totalCombos))/5;
  const adjusted=Math.max(0,raw*10-penalty);
  return {raw:raw*10, adjusted:Math.min(cap,adjusted), penalty, cap};
}
function classify(score){ if(score>=9.5) return '10/10 Candidate'; if(score>=8) return 'Very Robust'; if(score>=6.5) return 'Robust'; if(score>=4.5) return 'Interesting'; if(score>=2.5) return 'Weak'; return 'Fragile'; }
async function robustnessFor(d, candidate, baseOpts, datasets, totalCombos, rank){
  clearCache();
  const baselineBt=E().backtest(d,E().buildSignals(d,{indicator:candidate.indicator,params:candidate.params}).pos,baseOpts);
  const baseline=Object.assign({},baselineBt.metrics,extendMetrics(baselineBt.trades));
  const trades=baselineBt.trades;
  const conc=concentrationMetrics(trades), worst=worstTradeRemoval(trades), distr=distributionQuality(trades), clustering=clusteringMetrics(trades);
  const param=paramStability(d,candidate.indicator,candidate.params,baseOpts);
  const exit=exitIndependence(d,candidate.indicator,candidate.params,baseOpts);
  const purity=signalPurity(d,candidate.indicator,candidate.params,baseOpts);
  const direction=directionRobustness(d,candidate.indicator,candidate.params,baseOpts);
  const time=timeRobustness(d,candidate.indicator,candidate.params,baseOpts);
  const regime=regimeRobustness(d,candidate.indicator,candidate.params,baseOpts);
  const entry=entryPerturbation(d,candidate.indicator,candidate.params,baseOpts);
  const input=inputPerturbation(d,candidate.indicator,candidate.params,baseOpts);
  const jitter=jitterResilience(d,candidate.indicator,candidate.params,baseOpts);
  const order=tradeOrderRobustness(trades,baseOpts.capital||100000);
  const removalRegime=regimeRemoval(d,candidate.indicator,candidate.params,baseOpts);
  let cross=null; if(datasets&&datasets.length>1){ const other=datasets.find(x=>x.d!==d); if(other) cross=crossMarketTransfer(d,other.d,candidate.indicator,candidate.params,baseOpts,candidate.symbol||'A',other.symbol||'B'); }
  const subs=subScores({baseline,paramStability:param,density:param,exit,purity,direction,regime,time,entry,input,order,conc,worst,cross});
  const scored=finalScore(subs,totalCombos,rank);
  return {baseline,paramStability:param,exitIndependence:exit,signalPurity:purity,directionRobustness:direction,regimeRobustness:regime,timeRobustness:time,entryPerturbation:entry,inputPerturbation:input,jitterResilience:jitter,tradeOrder:order,concentration:conc,worstTradeRemoval:worst,regimeRemoval:removalRegime,crossMarket:cross,clustering,distribution:distr,subs,final:scored,classification:classify(scored.adjusted),
    log:{paramStability:param,exitIndependence:exit,signalPurity:purity,regime:regime,time:time,entry:entry,input:input,concentration:conc,worstTrade:worst,crossMarket:cross}};
}
const api={extendMetrics,paramStability,exitIndependence,signalPurity,directionRobustness,regimeRobustness,timeRobustness,entryPerturbation,inputPerturbation,jitterResilience,tradeOrderRobustness,concentrationMetrics,worstTradeRemoval,regimeRemoval,crossMarketTransfer,clusteringMetrics,distributionQuality,robustnessFor,clearCache,WEIGHTS,classify,subScores,finalScore};
if(typeof module!=='undefined'&&module.exports) module.exports=api;
root.XBOST_ROBUST=api;
})(typeof self!=='undefined'?self:this);
