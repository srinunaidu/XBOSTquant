// Indicator catalogue + default search ranges (mirrors the classic terminal).
export type IndMeta = { cat?: string; n?: string; d?: string; on?: boolean };

export const IND_META: IndMeta[] = [
  { cat: 'A · Classic trend, momentum & volatility' },
  { n: 'EMA', d: 'Trend · price vs EMA', on: true }, { n: 'SMA', d: 'Trend · price vs SMA', on: true },
  { n: 'HMA', d: 'Hull MA trend', on: true }, { n: 'DEMA', d: 'Double EMA trend', on: true },
  { n: 'Bollinger', d: 'Mean-reversion bands', on: true }, { n: 'Keltner', d: 'ATR channel breakout', on: true },
  { n: 'RSI', d: 'Momentum oversold/overbought', on: true }, { n: 'MACD', d: 'MACD vs signal', on: true },
  { n: 'VWAP', d: 'Intraday session VWAP', on: true }, { n: 'SuperTrend', d: 'ATR trailing trend', on: true },
  { n: 'ADX', d: 'ADX strength + MA', on: true }, { n: 'Stochastic', d: '%K/%D stochastic', on: true },
  { n: 'ChandeKroll', d: 'Chande-Kroll stops', on: true }, { n: 'POC', d: 'Volume Profile POC', on: true },
  { n: 'KAMA', d: '★ Kaufman adaptive MA', on: true }, { n: 'Fisher', d: '★ Fisher Transform turns', on: true },
  { n: 'Squeeze', d: '★ TTM squeeze release', on: true }, { n: 'CRSI', d: '★ Connors RSI mean-rev', on: true },
  { cat: 'B · Institutional Order Flow & Smart Money' },
  { n: 'VWAPBands', d: '★ VWAP ±1–3σ deviation bands', on: true }, { n: 'CVD', d: '★ Cumulative Volume Delta divergence', on: true },
  { n: 'FVG', d: '★ Fair Value Gap / imbalance taps', on: true },
  { n: 'Regime', d: '★ Choppiness gate for trend loops', on: true },
  { cat: 'C · Pure price/volume oscillators (new)' },
  { n: 'Chop', d: '★ Choppiness consolidation filter', on: true }, { n: 'Cyber', d: '★ Ehlers cycle turning points', on: true },
  { n: 'VWMA', d: '★ Volume-weighted MA trend', on: true }, { n: 'CMO', d: '★ Chande momentum exhaustion', on: true },
  { n: 'Aroon', d: '★ Time-between-highs trend', on: true },
  { cat: 'D · Combinatorial presets (multi-leg)' },
  { n: 'SqueezeBreak', d: '★P Squeeze + volume + CK stops', on: true }, { n: 'TrendRegime', d: '★P Chop gate + ST + MACD', on: true },
  { n: 'VWAPRev', d: '★P VWAP fade + CMO trigger', on: true },
];

export const DEFAULT_RANGES: Record<string, Record<string, [number, number, number]>> = {
  EMA: { period: [9, 30, 3] }, SMA: { period: [9, 30, 3] }, HMA: { period: [9, 30, 3] }, DEMA: { period: [9, 30, 3] },
  Bollinger: { period: [14, 28, 7], mult: [1.5, 2.5, 0.5] },
  Keltner: { emaPeriod: [14, 21, 7], atrPeriod: [10, 14, 4], mult: [1.5, 2.5, 0.5] },
  RSI: { period: [8, 20, 2], oversold: [20, 30, 10], overbought: [70, 80, 10] },
  MACD: { fast: [8, 12, 4], slow: [21, 26, 5], signal: [7, 9, 2] },
  VWAP: {},
  SuperTrend: { atrPeriod: [7, 14, 7], mult: [2, 4, 1] },
  ADX: { adxPeriod: [10, 14, 4], maPeriod: [30, 50, 20], threshold: [20, 25, 5] },
  Stochastic: { k: [10, 14, 4], d: [3, 5, 2], oversold: [15, 25, 10], overbought: [75, 85, 10] },
  ChandeKroll: { period: [7, 10, 3], mult: [2, 3, 1] },
  POC: { lookback: [30, 90, 30] },
  KAMA: { erPeriod: [10, 15, 5], fast: [2, 4, 2], slow: [20, 30, 10] },
  Fisher: { period: [9, 17, 4] },
  Squeeze: { bbPeriod: [14, 21, 7], bbMult: [2, 2.5, 0.5], kcPeriod: [14, 21, 7], kcMult: [1.5, 2, 0.5] },
  CRSI: { rsiPeriod: [2, 4, 1], streakPeriod: [2, 3, 1], rankPeriod: [50, 100, 50], oversold: [10, 20, 10], overbought: [80, 90, 10] },
  VWAPBands: { sd1: [1, 2, 1], sd2: [2, 3, 1] },
  CVD: { lookback: [20, 60, 20] },
  FVG: { maxZones: [3, 7, 2], mitAge: [20, 60, 20] },
  Regime: { chopPeriod: [10, 20, 5], gate: [55, 65, 5], maPeriod: [20, 40, 10] },
  Chop: { chopPeriod: [10, 20, 10], gate: [55, 65, 5], maPeriod: [20, 40, 20] },
  Cyber: { alpha: [0.05, 0.2, 0.05] },
  VWMA: { period: [10, 30, 10] },
  CMO: { period: [9, 21, 6], oversold: [-50, -30, 20], overbought: [30, 50, 20] },
  Aroon: { period: [14, 28, 14], level: [0, 25, 25] },
  SqueezeBreak: { period: [14, 21, 7], bbMult: [2, 2.5, 0.5], kcMult: [1.5, 2, 0.5], volMult: [1.5, 2.5, 1], ckMult: [2, 3, 1] },
  TrendRegime: { chopPeriod: [10, 20, 10], gate: [50, 60, 10], stMult: [2, 3, 1], macdFast: [8, 12, 4] },
  VWAPRev: { sd1: [1, 2, 1], sd2: [2, 3, 1], cmoPeriod: [5, 9, 4], cmoOS: [-50, -30, 20], cmoOB: [30, 50, 20] },
};

export const TFS = [1, 2, 3, 4, 5, 7, 10, 15];
export const EXIT_LBL: Record<string, string> = { fixed: 'FIX', breakeven: 'BE', atr: 'ATR', ck: 'CK' };

export type ExecOpts = {
  direction: string; sessionStart: string | null; sessionEnd: string | null;
  slPct: number; tpPct: number; trailPct: number; capital: number;
  qty: number; lotSize: number; cost: number;
  beTrigger: number; beLock: number; atrTrailPeriod: number; atrTrailMult: number;
  ckPeriod: number; ckMult: number; fill: string; entry: string;
};
