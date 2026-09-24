// Behavioral, time-based & statistical stress tests (selected strategy).
// Deterministic (seeded) so runs are reproducible and loggable.
import type { Trade } from './engine';

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Max drawdown of a pnl sequence on starting capital (ruin-aware equity).
function ddOf(pnls: number[], capital: number): number {
  let eq = capital, peak = capital, mdd = 0;
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    if (peak > 0) mdd = Math.min(mdd, ((eq - peak) / peak) * 100);
  }
  return mdd;
}

// Monte Carlo trade permutation: shuffle P&Ls N times, distribution of
// worst-case drawdowns. Answers: was my MaxDD luck of sequence or structure?
export function monteCarloDD(trades: Trade[], capital: number, iters = 1000, seed = 42) {
  const base = trades.map(t => t.pnl);
  if (!base.length) return null;
  const rnd = mulberry(seed);
  const out = new Float64Array(iters);
  for (let k = 0; k < iters; k++) {
    const arr = base.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    out[k] = ddOf(arr, capital);
  }
  const s = Array.from(out).sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(iters - 1, Math.floor(p * iters))];
  return {
    iters, mean: s.reduce((a, b) => a + b, 0) / iters,
    p5: q(0.05), p50: q(0.5), p95: q(0.95), worst: s[0],
  };
}

// Consecutive-loss streaks + approximate P(≥k-loss streak in n trades).
// Approximation: 1-(1-q^k)^(n-k+1), q = loss rate. Labelled approximate.
export function streakStats(trades: Trade[]) {
  let maxL = 0, maxW = 0, cl = 0, cw = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxW) maxW = cw; }
    else { cl++; cw = 0; if (cl > maxL) maxL = cl; }
  }
  const n = trades.length;
  const q = n ? trades.filter(t => t.pnl <= 0).length / n : 0;
  const prob = (k: number) => {
    if (n < k || q <= 0) return 0;
    if (q >= 1) return 1;
    return 1 - Math.pow(1 - Math.pow(q, k), Math.max(1, n - k + 1));
  };
  return {
    maxLossStreak: maxL, maxWinStreak: maxW,
    p4: prob(4), p5: prob(5), p6: prob(6),
  };
}

// Session heatmap buckets (IST clock minutes).
export const HEAT_BUCKETS = [
  { label: '09:15–10:00', from: 555, to: 600 },
  { label: '10:00–12:00', from: 600, to: 720 },
  { label: '12:00–14:00', from: 720, to: 840 },
  { label: '14:00–15:30', from: 840, to: 930 },
];

// MCX commodities trade 09:00–23:30 — NSE buckets would misattribute.
export const HEAT_BUCKETS_MCX = [
  { label: '09:00–12:00', from: 540, to: 720 },
  { label: '12:00–15:30', from: 720, to: 930 },
  { label: '15:30–19:00', from: 930, to: 1140 },
  { label: '19:00–23:30', from: 1140, to: 1410 },
];

export function heatmap(trades: Trade[], buckets = HEAT_BUCKETS) {
  return buckets.map(b => {
    const ts = trades.filter(t => {
      const dt = new Date(t.exitTime);
      const m = dt.getHours() * 60 + dt.getMinutes();
      return m >= b.from && m < b.to;
    });
    const pnl = ts.reduce((s, t) => s + t.pnl, 0);
    const w = ts.filter(t => t.pnl > 0).length;
    return { label: b.label, n: ts.length, wr: ts.length ? (100 * w) / ts.length : 0, pnl };
  });
}

// MAE/MFE aggregates.
export function excursionStats(trades: Trade[]) {
  if (!trades.length) return null;
  let mae = 0, mfe = 0;
  for (const t of trades) { mae += (t as any).mae || 0; mfe += (t as any).mfe || 0; }
  return { avgMAE: mae / trades.length, avgMFE: mfe / trades.length };
}
