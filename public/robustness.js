/* XBOST Indicator & Combination Robustness Engine — public/robustness.js
 * UMD: attaches window.XBOST_ROBUST (and root.XBOST_ROBUST for workers).
 * See FORMULAS.md §9 and DOCUMENTATION.md §6 for weights/caps.
 * §27 staged: only Top-N are stressed. This file is pure quant; no DOM. */
(function (root) {
'use strict';
const E = () => {
  const e = (root.XBOST_ENGINE || (typeof window !== 'undefined' && window.XBOST_ENGINE));
  if (!e) throw new Error('XBOST_ENGINE not loaded before robustness.js');
  return e;
};

// ---------- §1 baseline extension ----------
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)));
  return s[idx];
}
function quantile(a, p) { return percentile(a, p); }
function skewness(a, mean, sd) {
  if (!a.length || sd === 0) return 0;
  let s = 0; for (const x of a) s += Math.pow((x - mean) / sd, 3);
  return s / a.length;
}
function kurtosis(a, mean, sd) {
  if (!a.length || sd === 0) return 0;
  let s = 0; for (const x of a) s += Math.pow((x - mean) / sd, 4);
  return s / a.length - 3;
}
function extendMetrics(trades) {
  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const med = median(pnls);
  const sd = pnls.length > 1 ? Math.sqrt(pnls.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (pnls.length - 1)) : 0;
  const sWins = [...wins].sort((a, b) => a - b);
  const sLoss = [...losses].sort((a, b) => a - b);
  const avgW = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgL = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const medW = median(wins), medL = median(losses);
  const pf = (() => { let gp = 0, gl = 0; for (const p of pnls) { if (p > 0) gp += p; else gl += -p; } return gl > 0 ? gp / gl : (gp > 0 ? 99.99 : 0); })();
  const payoff = avgL !== 0 ? Math.abs(avgW / avgL) : 0;
  const mae = trades.map(t => t.mae || 0);
  const mfe = trades.map(t => t.mfe || 0);
  const totalPnL = pnls.reduce((a, b) => a + b, 0);
  const largestWinner = wins.length ? Math.max(...wins) : 0;
  const largestLoser = losses.length ? Math.min(...losses) : 0;
  // longest streaks
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  for (const p of pnls) {
    if (p > 0) { curW++; curL = 0; if (curW > maxW) maxW = curW; }
    else { curL++; curW = 0; if (curL > maxL) maxL = curL; }
  }
  const sortedDesc = [...pnls].sort((a, b) => b - a);
  const top1 = sortedDesc.slice(0, 1).reduce((a, b) => a + b, 0);
  const top5 = sortedDesc.slice(0, 5).reduce((a, b) => a + b, 0);
  const top10 = sortedDesc.slice(0, 10).reduce((a, b) => a + b, 0);
  const absTotal = Math.abs(totalPnL) || 1;
  return {
    avgWinner: avgW, avgLoser: avgL, medianWinner: medW, medianLoser: medL,
    medianPnL: med, expectancy: mean, payoffRatio: payoff, profitFactor: pf,
    mean, median: med, sd, skewness: skewness(pnls, mean, sd), kurtosis: kurtosis(pnls, mean, sd),
    p5: quantile(pnls, 0.05), p25: quantile(pnls, 0.25), p50: quantile(pnls, 0.50), p75: quantile(pnls, 0.75), p95: quantile(pnls, 0.95),
    largestWinner, largestLoser, longestWinningStreak: maxW, longestLosingStreak: maxL,
    totalPnL, top1PnL: top1, top5PnL: top5, top10PnL: top10,
    top1Pct: totalPnL ? (top1 / totalPnL) * 100 : 0,
    top5Pct: totalPnL ? (top5 / totalPnL) * 100 : 0,
    top10Pct: totalPnL ? (top10 / totalPnL) * 100 : 0,
    avgMAE: mae.length ? mae.reduce((a, b) => a + b, 0) / mae.length : 0,
    avgMFE: mfe.length ? mfe.reduce((a, b) => a + b, 0) / mfe.length : 0,
    medianMAE: median(mae), medianMFE: median(mfe),
    maes: mae, mfes: mfe, pnls, wins, losses, sortedDesc,
  };
}

// ---------- shared helpers ----------
function backtestFor(entry) {
  const e = E();
  return (d, indicator, params, opts) => {
    const sig = e.buildSignals(d, { indicator, params });
    const bt = e.backtest(d, sig.pos, opts);
    return bt;
  };
}
let _cache = new Map();
function cachedBacktest(d, indicator, params, opts) {
  const k = [indicator, JSON.stringify(params), JSON.stringify([opts.slPct, opts.tpPct, opts.exit, opts.carry, opts.direction, opts.fill, opts.entry])].join('|');
  if (_cache.has(k)) return _cache.get(k);
  const bt = E().backtest(d, E().buildSignals(d, { indicator, params }).pos, opts);
  _cache.set(k, bt);
  return bt;
}
function clearCache() { _cache = new Map(); }

function paramNeighborValues(key, val, step) {
  const vals = new Set();
  const deltas = [-2, -1, 0, 1, 2];
  for (const d of deltas) {
    let v = +(val + d * step).toFixed(4);
    if (!isFinite(v) || v <= 0) continue;
    if (['period', 'fast', 'slow', 'signal', 'k', 'd', 'emaPeriod', 'atrPeriod', 'adxPeriod', 'maPeriod', 'lookback', 'rsiPeriod', 'streakPeriod', 'rankPeriod', 'erPeriod', 'bbPeriod', 'kcPeriod'].includes(key)) {
      if (!Number.isInteger(v) || v < 2) continue;
    }
    vals.add(v);
  }
  return [...vals].sort((a, b) => a - b);
}
function genParamNeighbors(indicator, params) {
  const schema = (E().SCHEMA[indicator] || []);
  const axes = schema.map(p => {
    const v = params[p.key] ?? p.def;
    const step = (() => {
      if (String(p.key).toLowerCase().includes('mult')) return 0.2;
      if (['oversold', 'overbought', 'gate', 'threshold', 'level'].includes(p.key)) return 5;
      if (p.key === 'alpha') return 0.02;
      return 1;
    })();
    return paramNeighborValues(p.key, v, step).map(val => ({ key: p.key, val }));
  }).filter(a => a.length);
  if (!axes.length) return [Object.assign({}, params)];
  let res = [[]];
  for (const arr of axes) {
    const tmp = [];
    for (const r of res) for (const v of arr) tmp.push(r.concat([v]));
    res = tmp.length > 80 ? tmp.slice(0, 80) : tmp;
  }
  return res.map(list => { const o = Object.assign({}, params); for (const kv of list) o[kv.key] = kv.val; return o; });
}

// ---------- §2 param stability + §3 density ----------
function paramStability(d, indicator, params, baseOpts) {
  const neighbors = genParamNeighbors(indicator, params);
  const results = neighbors.map(p => {
    const bt = cachedBacktest(d, indicator, p, baseOpts);
    return { params: p, bt };
  });
  const sharpes = results.map(r => r.bt.metrics.sharpe);
  const exps = results.map(r => r.bt.metrics.expectancy);
  const profitable = results.filter(r => r.bt.metrics.netPnL > 0).length;
  const posExp = results.filter(r => r.bt.metrics.expectancy > 0).length;
  const strongSharpe = results.filter(r => r.bt.metrics.sharpe > 1.0).length;
  const med = (arr) => median(arr);
  const sd = (arr, m) => {
    if (arr.length < 2) return 0;
    const mu = m ?? arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (arr.length - 1));
  };
  const baseIdx = results.findIndex(r => JSON.stringify(r.params) === JSON.stringify(params));
  const baseSharpe = baseIdx >= 0 ? sharpes[baseIdx] : results[0]?.bt.metrics.sharpe || 0;
  const medSharpe = med(sharpes), medExp = med(exps);
  const p5Sharpe = percentile(sharpes, 0.05), p5Exp = percentile(exps, 0.05);
  const worst = Math.min(...sharpes), best = Math.max(...sharpes);
  const drop = baseSharpe ? ((baseSharpe - medSharpe) / Math.abs(baseSharpe)) : 0;
  const density = neighbors.length ? profitable / neighbors.length : 0;
  const strongDensity = neighbors.length ? strongSharpe / neighbors.length : 0;
  const posExpDensity = neighbors.length ? posExp / neighbors.length : 0;
  return {
    neighbors: neighbors.length, profitable, pctProfitable: density * 100, posExp, pctPosExp: posExpDensity * 100,
    strongSharpe, pctStrongSharpe: strongDensity * 100,
    medianSharpe: medSharpe, medianExpectancy: medExp, medianWR: median(results.map(r => r.bt.metrics.winRate)),
    p5Sharpe, p5Expectancy: p5Exp, worstSharpe: worst, bestSharpe: best,
    sdSharpe: sd(sharpes), sdExpectancy: sd(exps), dropToMedian: drop,
    density, strongDensity, posExpDensity,
    neighborMetrics: results.map(r => ({ params: r.params, sharpe: r.bt.metrics.sharpe, expectancy: r.bt.metrics.expectancy, wr: r.bt.metrics.winRate, pnl: r.bt.metrics.netPnL })),
  };
}

// ---------- §4 exit independence ----------
const EXIT_VARIANTS = [
  { slPct: 0.5, tpPct: 1.0, exit: 'fixed' },
  { slPct: 0.8, tpPct: 1.5, exit: 'fixed' },
  { slPct: 1.1, tpPct: 2.0, exit: 'fixed' },
  { slPct: 0.5, tpPct: 1.0, exit: 'breakeven', beTrigger: 0.5, beLock: 0 },
  { slPct: 0.8, tpPct: 1.5, exit: 'breakeven', beTrigger: 0.8, beLock: 0 },
  { slPct: 0.5, tpPct: 2.0, exit: 'fixed', trailPct: 0.5 },
  { slPct: 0, tpPct: 0, exit: 'fixed' },
  { slPct: 0.8, tpPct: 0, exit: 'fixed' },
  { slPct: 1.0, tpPct: 2.0, exit: 'fixed' },
  { slPct: 0.8, tpPct: 1.5, exit: 'atr', atrTrailPeriod: 14, atrTrailMult: 3 },
  { slPct: 0.8, tpPct: 1.5, exit: 'atr', atrTrailPeriod: 10, atrTrailMult: 2 },
  { slPct: 10, tpPct: 3, exit: 'ck', ckPeriod: 10, ckMult: 3 },
  { slPct: 10, tpPct: 3, exit: 'ck', ckPeriod: 14, ckMult: 2 },
  { slPct: 0.8, tpPct: 1.5, exit: 'fixed', sessionFlat: true },
];
function exitIndependence(d, indicator, params, baseOpts) {
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const results = EXIT_VARIANTS.map(v => {
    const opts = Object.assign({}, baseOpts, { slPct: v.slPct, tpPct: v.tpPct, exit: v.exit, beTrigger: v.beTrigger, beLock: v.beLock, atrTrailPeriod: v.atrTrailPeriod, atrTrailMult: v.atrTrailMult, ckPeriod: v.ckPeriod, ckMult: v.ckMult, trailPct: v.trailPct || baseOpts.trailPct });
    const bt = E().backtest(d, sig, opts);
    return { variant: v, bt };
  });
  const sharpes = results.map(r => r.bt.metrics.sharpe);
  const exps = results.map(r => r.bt.metrics.expectancy);
  return {
    variants: results.length, profitable: results.filter(r => r.bt.metrics.netPnL > 0).length,
    posExp: results.filter(r => r.bt.metrics.expectancy > 0).length,
    medianSharpe: median(sharpes), medianExpectancy: median(exps),
    bestSharpe: Math.max(...sharpes), worstSharpe: Math.min(...sharpes),
    pctProfitable: results.filter(r => r.bt.metrics.netPnL > 0).length / results.length * 100,
    pctPosExp: results.filter(r => r.bt.metrics.expectancy > 0).length / results.length * 100,
    dispersion: sharpes.length > 1 ? Math.sqrt(sharpes.reduce((s, x) => s + (x - median(sharpes)) ** 2, 0) / sharpes.length) : 0,
    details: results.map(r => ({ exit: r.variant.exit, sl: r.variant.slPct, tp: r.variant.tpPct, sharpe: r.bt.metrics.sharpe, exp: r.bt.metrics.expectancy, pnl: r.bt.metrics.netPnL })),
  };
}

// ---------- §5 signal purity ----------
function signalPurity(d, indicator, params, baseOpts) {
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const run = (extra) => E().backtest(d, sig, Object.assign({}, baseOpts, extra)).metrics;
  const a = run({ slPct: 0, tpPct: 0, exit: 'fixed', carry: true });
  const b = run(Object.assign({}, baseOpts)); // direction included
  const c = run({ slPct: 0, tpPct: 0, exit: 'fixed', carry: true, _purityBypass: true });
  // For C we need regime: use day routing if available
  let regSharpe = null;
  try {
    const reg = E().regimeSeries ? E().regimeSeries(d, {}) : null;
    if (reg) {
      const m = E().regimeMask(reg, indicator);
      regSharpe = E().backtest(d, sig, Object.assign({}, baseOpts, { slPct: 0, tpPct: 0, tradeMask: m })).metrics.sharpe;
    }
  } catch { /* noop */ }
  const full = E().backtest(d, sig, baseOpts).metrics;
  const ratio = full.expectancy ? a.expectancy / full.expectancy : 0;
  const sharpeRatio = full.sharpe ? a.sharpe / full.sharpe : 0;
  return {
    indicatorOnly: { sharpe: a.sharpe, expectancy: a.expectancy, wr: a.winRate, pf: a.profitFactor },
    full: { sharpe: full.sharpe, expectancy: full.expectancy },
    regimeSharpe: regSharpe, ratio, sharpeRatio,
  };
}

// ---------- §6 direction ----------
function directionRobustness(d, indicator, params, baseOpts) {
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const mk = (dir) => E().backtest(d, sig, Object.assign({}, baseOpts, { direction: dir })).metrics;
  const both = mk('Both'), lo = mk('Long'), sh = mk('Short');
  const longQ = lo.sharpe, shortQ = sh.sharpe;
  const bal = both.sharpe ? 1 - Math.abs(longQ - shortQ) / (Math.abs(longQ) + Math.abs(shortQ) + 1e-9) : 0;
  return {
    both, long: lo, short: sh,
    longSharpe: longQ, shortSharpe: shortQ,
    balance: bal, longPnl: lo.netPnL, shortPnl: sh.netPnL,
  };
}

// ---------- §7 regime ----------
function regimeRobustness(d, indicator, params, baseOpts) {
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const regs = E().regimeSeries ? E().regimeSeries(d, {}) : new Int8Array(d.t.length).fill(3);
  const buckets = [0, 1, 2, 3].map(r => {
    const mask = new Int8Array(d.t.length).fill(0);
    for (let i = 0; i < d.t.length; i++) if (regs[i] === r) mask[i] = 1;
    // run only on regime bars: use tradeMask
    const bt = E().backtest(d, sig, Object.assign({}, baseOpts, { tradeMask: mask }));
    return { regime: r, bt: bt.metrics };
  });
  const exps = buckets.map(b => b.bt.expectancy);
  const shs = buckets.map(b => b.bt.sharpe);
  return {
    buckets,
    profitableRegimes: buckets.filter(b => b.bt.netPnL > 0).length,
    posExpRegimes: buckets.filter(b => b.bt.expectancy > 0).length,
    medianExpectancy: median(exps), worstExpectancy: Math.min(...exps),
    medianSharpe: median(shs), worstSharpe: Math.min(...shs),
    dispersion: shs.length > 1 ? Math.sqrt(shs.reduce((s, x) => s + (x - median(shs)) ** 2, 0) / shs.length) : 0,
  };
}

// ---------- §8 time-of-day ----------
function timeRobustness(d, indicator, params, baseOpts) {
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const windows = [[555, 600], [600, 720], [720, 840], [840, 930]];
  const labels = ['09:15–10:00', '10:00–12:00', '12:00–14:00', '14:00–15:30'];
  const buckets = windows.map(([a, b], idx) => {
    const mask = E().buildWindowMask ? E().buildWindowMask(d.t, [[a, b]]) : new Int8Array(d.t.length).fill(1);
    const bt = E().backtest(d, sig, Object.assign({}, baseOpts, { tradeMask: mask }));
    return { label: labels[idx], bt: bt.metrics };
  });
  const exps = buckets.map(b => b.bt.expectancy);
  const concentration = (() => {
    const pnls = buckets.map(b => Math.abs(b.bt.netPnL));
    const total = pnls.reduce((a, c) => a + c, 0) || 1;
    const sorted = [...pnls].sort((a, b) => b - a);
    return sorted[0] / total;
  })();
  return {
    buckets,
    medianExpectancy: median(exps), worstExpectancy: Math.min(...exps),
    profitableWindows: buckets.filter(b => b.bt.netPnL > 0).length,
    concentration,
  };
}

// ---------- §9 entry perturbation + §10 input perturbation + §11 jitter ----------
function entryPerturbation(d, indicator, params, baseOpts) {
  const variants = [0, 1, 2].map(shift => {
    const sig = E().buildSignals(d, { indicator, params }).pos;
    if (shift === 0) return sig;
    const s2 = new Int8Array(sig.length);
    for (let i = shift; i < sig.length; i++) s2[i] = sig[i - shift];
    return s2;
  });
  const results = variants.map(s => E().backtest(d, s, baseOpts).metrics);
  const exps = results.map(r => r.expectancy), shs = results.map(r => r.sharpe);
  return {
    variants: results.length, profitable: results.filter(r => r.netPnL > 0).length,
    posExp: results.filter(r => r.expectancy > 0).length,
    medianExpectancy: median(exps), medianSharpe: median(shs),
    bestSharpe: Math.max(...shs), worstSharpe: Math.min(...shs),
  };
}
function inputPerturbation(d, indicator, params, baseOpts) {
  const p = paramStability(d, indicator, params, baseOpts);
  const exps = p.neighborMetrics.map(n => n.expectancy);
  return {
    medianExpectancy: median(exps), medianSharpe: median(p.neighborMetrics.map(n => n.sharpe)),
    worstSharpe: p.worstSharpe, bestSharpe: p.bestSharpe,
    profitable: p.profitable, total: p.neighbors,
  };
}
function jitterResilience(d, indicator, params, baseOpts) {
  const baseSig = E().buildSignals(d, { indicator, params }).pos;
  const levels = [0, 0.1, 0.3, 0.6];
  const out = levels.map(j => {
    let sig = baseSig;
    if (j > 0) {
      sig = new Int8Array(baseSig.length);
      for (let i = 0; i < baseSig.length; i++) {
        if (Math.random() < j * 0.1) sig[i] = baseSig[i] === 1 ? -1 : baseSig[i] === -1 ? 1 : 0;
        else sig[i] = baseSig[i];
      }
    }
    return E().backtest(d, sig, baseOpts).metrics;
  });
  return { levels, results: out };
}

// ---------- §12 trade-order randomization ----------
function tradeOrderRobustness(trades, capital) {
  if (!trades.length) return { medianSharpe: 0, p5Sharpe: 0, p95Sharpe: 0, medianDD: 0, p95DD: 0, medianStreak: 0, p95Streak: 0 };
  const pnls = trades.map(t => t.pnl);
  const iters = 1000;
  const sharpes = [], dds = [], streaks = [];
  for (let k = 0; k < iters; k++) {
    const arr = [...pnls].sort(() => Math.random() - 0.5);
    let eq = capital, peak = capital, mdd = 0, win = 0, maxLose = 0, curL = 0;
    let rets = [];
    for (const p of arr) {
      const prev = eq; eq += p;
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? (eq - peak) / peak * 100 : 0; if (dd < mdd) mdd = dd;
      rets.push((eq - prev) / Math.max(1, Math.abs(prev)));
      if (p > 0) curL = 0; else { curL++; if (curL > maxLose) maxLose = curL; }
    }
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, rets.length - 1)) || 1e-9;
    sharpes.push(mu / sd * Math.sqrt(252));
    dds.push(mdd); streaks.push(maxLose);
  }
  return {
    medianSharpe: median(sharpes), p5Sharpe: percentile(sharpes, 0.05), p95Sharpe: percentile(sharpes, 0.95),
    medianDD: median(dds), p95DD: percentile(dds, 0.05),
    medianStreak: median(streaks), p95Streak: percentile(streaks, 0.95),
  };
}

// ---------- §13 concentration + §14 worst-trade removal ----------
function concentrationMetrics(trades) {
  const pnls = trades.map(t => t.pnl);
  const total = pnls.reduce((a, b) => a + b, 0) || 1;
  const sorted = [...pnls].sort((a, b) => b - a);
  const sumTop = (k) => sorted.slice(0, Math.max(1, Math.ceil(pnls.length * k / 100))).reduce((a, b) => a + b, 0);
  const top1 = sumTop(1), top5 = sumTop(5), top10 = sumTop(10);
  const wins = pnls.filter(p => p > 0);
  const largestWinner = wins.length ? Math.max(...wins) : 0;
  return {
    top1Pct: (top1 / total) * 100, top5Pct: (top5 / total) * 100, top10Pct: (top10 / total) * 100,
    largestWinner, largestWinnerPct: (largestWinner / Math.abs(total)) * 100,
    top5Winners: sorted.slice(0, 5).reduce((a, b) => a + b, 0),
    top10Winners: sorted.slice(0, 10).reduce((a, b) => a + b, 0),
  };
}
function worstTradeRemoval(trades) {
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const ks = [1, 3, 5, 10];
  const out = {};
  for (const k of ks) {
    const remaining = [...trades].sort((a, b) => b.pnl - a.pnl).slice(k);
    if (!remaining.length) { out['remove' + k] = { sharpe: 0, expectancy: 0, pf: 0, wr: 0 }; continue; }
    const pnls = remaining.map(t => t.pnl);
    const wins = pnls.filter(p => p > 0);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const mu = mean;
    const rets = pnls.map(p => p / 1000);
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu / 1000) ** 2, 0) / Math.max(1, rets.length - 1)) || 1e-9;
    const sharpe = mu / 1000 / sd * Math.sqrt(252);
    const gp = wins.reduce((a, b) => a + b, 0), gl = pnls.filter(p => p <= 0).reduce((a, b) => a + -b, 0);
    const pf = gl > 0 ? gp / gl : (gp > 0 ? 99.99 : 0);
    out['remove' + k] = { sharpe, expectancy: mean, pf, wr: wins.length / pnls.length * 100 };
  }
  return out;
}

// ---------- §15 regime removal + §16 cross-market + §17 clustering + §18 distribution ----------
function regimeRemoval(d, indicator, params, baseOpts) {
  const regs = E().regimeSeries ? E().regimeSeries(d, {}) : new Int8Array(d.t.length).fill(0);
  const sig = E().buildSignals(d, { indicator, params }).pos;
  const full = E().backtest(d, sig, baseOpts).metrics;
  const variants = [0, 1, 2, 3].map(r => {
    const mask = new Int8Array(d.t.length);
    for (let i = 0; i < d.t.length; i++) mask[i] = regs[i] === r ? 0 : 1;
    const bt = E().backtest(d, sig, Object.assign({}, baseOpts, { tradeMask: mask }));
    return { regime: r, sharpe: bt.metrics.sharpe, exp: bt.metrics.expectancy, pnl: bt.metrics.netPnL };
  });
  return { fullSharpe: full.sharpe, variants };
}
function crossMarketTransfer(dA, dB, indicator, params, baseOpts, discoveredOn, testedOn) {
  const sigA = E().buildSignals(dA, { indicator, params }).pos;
  const sigB = E().buildSignals(dB, { indicator, params }).pos;
  const a = E().backtest(dA, sigA, baseOpts).metrics;
  const b = E().backtest(dB, sigB, baseOpts).metrics;
  return {
    discoveredOn, testedOn, reoptimized: false,
    discovered: { sharpe: a.sharpe, exp: a.expectancy, wr: a.winRate, pf: a.profitFactor },
    tested: { sharpe: b.sharpe, exp: b.expectancy, wr: b.winRate, pf: b.profitFactor },
    sharpeRetention: a.sharpe ? b.sharpe / a.sharpe : 0,
  };
}
function clusteringMetrics(trades) {
  const pnls = trades.map(t => t.pnl);
  let sameWin = 0, sameLoss = 0;
  for (let i = 1; i < pnls.length; i++) {
    if (pnls[i] > 0 && pnls[i - 1] > 0) sameWin++;
    if (pnls[i] <= 0 && pnls[i - 1] <= 0) sameLoss++;
  }
  const ac = (() => {
    if (pnls.length < 3) return 0;
    const mu = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    let num = 0, den = 0;
    for (let i = 1; i < pnls.length; i++) num += (pnls[i] - mu) * (pnls[i - 1] - mu);
    for (const x of pnls) den += (x - mu) ** 2;
    return den ? num / den : 0;
  })();
  return { winClustering: sameWin, lossClustering: sameLoss, autocorrelation: ac, highClustering: (sameWin + sameLoss) / Math.max(1, pnls.length - 1) > 0.6 };
}
function distributionQuality(trades) {
  const pnls = trades.map(t => t.pnl);
  if (!pnls.length) return { mean: 0, median: 0, sd: 0, skewness: 0, kurtosis: 0, p5: 0, p25: 0, p50: 0, p75: 0, p95: 0 };
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const med = median(pnls);
  const sd = Math.sqrt(pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, pnls.length - 1));
  return {
    mean, median: med, sd,
    skewness: skewness(pnls, mean, sd), kurtosis: kurtosis(pnls, mean, sd),
    p5: percentile(pnls, 0.05), p25: percentile(pnls, 0.25), p50: percentile(pnls, 0.50), p75: percentile(pnls, 0.75), p95: percentile(pnls, 0.95),
  };
}

// ---------- helpers: normalized 0-10 scoring ----------
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function score01(x) { return clamp01(x) * 10; }

// ---------- §20 robustness score 0-10 + §21 caps ----------
const WEIGHTS = {
  core: 0.15, paramStability: 0.15, density: 0.10, exitIndep: 0.10, purity: 0.10,
  direction: 0.05, regime: 0.10, time: 0.05, entry: 0.05, inputJitter: 0.05,
  order: 0.05, concentration: 0.05, worstTrade: 0.05, crossMarket: 0.05,
};
function subScores(r) {
  const s = {};
  s.core = clamp01((r.baseline.sharpe / 5 + r.baseline.profitFactor / 4) / 2);
  const ps = r.paramStability;
  s.paramStability = ps ? clamp01(1 - ps.sdSharpe / 5) * clamp01(ps.density) : 0;
  s.density = ps ? clamp01(ps.density) : 0;
  s.exitIndep = r.exit ? clamp01(r.exit.pctPosExp / 100) : 0;
  s.purity = r.purity ? clamp01(r.purity.ratio) : 0;
  s.direction = r.direction ? r.direction.balance : 0;
  s.regime = r.regime ? clamp01(r.regime.posExpRegimes / 4) : 0;
  s.time = r.time ? clamp01(r.time.profitableWindows / 4) : 0;
  s.entry = r.entry ? clamp01(r.entry.posExp / r.entry.variants) : 0;
  s.inputJitter = r.input ? clamp01(1 - Math.abs(r.input.medianSharpe - r.baseline.sharpe) / 5) : 0;
  s.order = r.order ? clamp01(0.5 + r.order.p5Sharpe / 10) : 0;
  s.concentration = r.conc ? clamp01(1 - Math.abs(r.conc.top5Pct) / 80) : 0;
  s.worstTrade = r.worst ? clamp01(r.worst.remove5 ? (r.worst.remove5.sharpe / Math.max(1, r.baseline.sharpe)) : 0) : 0;
  s.crossMarket = r.cross ? clamp01(r.cross.sharpeRetention) : 0.5; // neutral if not tested
  return s;
}
function finalScore(subs, totalCombos, rank) {
  let raw = 0;
  for (const k of Object.keys(WEIGHTS)) raw += (subs[k] || 0) * WEIGHTS[k];
  // caps §21
  let cap = 10;
  if ((subs.purity || 0) * 10 < 3) cap = Math.min(cap, 6);
  if ((subs.paramStability || 0) * 10 < 3) cap = Math.min(cap, 6);
  if ((subs.density || 0) * 10 < 3) cap = Math.min(cap, 6);
  if ((subs.exitIndep || 0) * 10 < 3) cap = Math.min(cap, 7);
  if ((subs.worstTrade || 0) * 10 < 3) cap = Math.min(cap, 7);
  const penalty = Math.log10(Math.max(1, totalCombos)) / 5;
  const adjusted = Math.max(0, raw * 10 - penalty);
  return { raw: raw * 10, adjusted: Math.min(cap, adjusted), penalty, cap };
}
function classify(score) {
  if (score >= 9.5) return '10/10 Candidate';
  if (score >= 8) return 'Very Robust';
  if (score >= 6.5) return 'Robust';
  if (score >= 4.5) return 'Interesting';
  if (score >= 2.5) return 'Weak';
  return 'Fragile';
}

// ---------- main: staged robustness for one candidate ----------
async function robustnessFor(d, candidate, baseOpts, datasets, totalCombos, rank) {
  clearCache();
  const baselineBt = E().backtest(d, E().buildSignals(d, { indicator: candidate.indicator, params: candidate.params }).pos, baseOpts);
  const baseline = Object.assign({}, baselineBt.metrics, extendMetrics(baselineBt.trades));
  const trades = baselineBt.trades;
  // cheap
  const conc = concentrationMetrics(trades);
  const worst = worstTradeRemoval(trades);
  const distr = distributionQuality(trades);
  const clustering = clusteringMetrics(trades);
  // medium
  const param = paramStability(d, candidate.indicator, candidate.params, baseOpts);
  const exit = exitIndependence(d, candidate.indicator, candidate.params, baseOpts);
  const purity = signalPurity(d, candidate.indicator, candidate.params, baseOpts);
  const direction = directionRobustness(d, candidate.indicator, candidate.params, baseOpts);
  const time = timeRobustness(d, candidate.indicator, candidate.params, baseOpts);
  const regime = regimeRobustness(d, candidate.indicator, candidate.params, baseOpts);
  const entry = entryPerturbation(d, candidate.indicator, candidate.params, baseOpts);
  const input = inputPerturbation(d, candidate.indicator, candidate.params, baseOpts);
  const jitter = jitterResilience(d, candidate.indicator, candidate.params, baseOpts);
  // heavy: only top-25 get full suite; others get sampled
  const order = tradeOrderRobustness(trades, baseOpts.capital || 100000);
  const removalRegime = regimeRemoval(d, candidate.indicator, candidate.params, baseOpts);
  let cross = null;
  if (datasets && datasets.length > 1) {
    const other = datasets.find(x => x.d !== d);
    if (other) cross = crossMarketTransfer(d, other.d, candidate.indicator, candidate.params, baseOpts, candidate.symbol || 'A', other.symbol || 'B');
  }
  const subs = subScores({ baseline, paramStability: param, density: param, exit, purity, direction, regime, time, entry, input, order, conc, worst, cross });
  const scored = finalScore(subs, totalCombos, rank);
  return {
    baseline, paramStability: param, exitIndependence: exit, signalPurity: purity,
    directionRobustness: direction, regimeRobustness: regime, timeRobustness: time,
    entryPerturbation: entry, inputPerturbation: input, jitterResilience: jitter,
    tradeOrder: order, concentration: conc, worstTradeRemoval: worst,
    regimeRemoval: removalRegime, crossMarket: cross, clustering, distribution: distr,
    subs, final: scored, classification: classify(scored.adjusted),
    log: {
      paramStability: param, exitIndependence: exit, signalPurity: purity,
      regime: regime, time: time, entry: entry, input: input,
      concentration: conc, worstTrade: worst, crossMarket: cross,
    },
  };
}

const api = {
  extendMetrics, paramStability, exitIndependence, signalPurity, directionRobustness,
  regimeRobustness, timeRobustness, entryPerturbation, inputPerturbation, jitterResilience,
  tradeOrderRobustness, concentrationMetrics, worstTradeRemoval, regimeRemoval,
  crossMarketTransfer, clusteringMetrics, distributionQuality,
  robustnessFor, clearCache, WEIGHTS, classify, subScores, finalScore,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.XBOST_ROBUST = api;
})(typeof self !== 'undefined' ? self : this);
