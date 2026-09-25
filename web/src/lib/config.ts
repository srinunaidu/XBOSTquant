// Indicator catalogue + default search ranges (mirrors the classic terminal).
export type IndMeta = { cat?: string; n?: string; d?: string; on?: boolean; tier?: string };
export const TIERS = ['A', 'B', 'C'] as const;

export const IND_META: IndMeta[] = [
  { cat: 'A · Classic trend, momentum & volatility' },
  {tier: 'A', n: 'EMA', d: 'Trend · price vs EMA', on: true }, {tier: 'B', n: 'SMA', d: 'Trend · price vs SMA', on: false },
  {tier: 'B', n: 'HMA', d: 'Hull MA trend', on: false }, {tier: 'B', n: 'DEMA', d: 'Double EMA trend', on: false },
  {tier: 'A', n: 'Bollinger', d: 'Mean-reversion bands', on: true }, {tier: 'B', n: 'Keltner', d: 'ATR channel breakout', on: false },
  {tier: 'A', n: 'RSI', d: 'Momentum oversold/overbought', on: true }, {tier: 'B', n: 'MACD', d: 'MACD vs signal', on: false },
  {tier: 'B', n: 'VWAP', d: 'Intraday session VWAP', on: false }, {tier: 'A', n: 'SuperTrend', d: 'ATR trailing trend', on: true },
  {tier: 'B', n: 'ADX', d: 'ADX strength + MA', on: false }, {tier: 'A', n: 'Stochastic', d: '%K/%D stochastic', on: true },
  {tier: 'C', n: 'ChandeKroll', d: 'Chande-Kroll stops', on: false }, {tier: 'B', n: 'POC', d: 'Volume Profile POC', on: false },
  {tier: 'A', n: 'KAMA', d: '★ Kaufman adaptive MA', on: true }, {tier: 'C', n: 'Fisher', d: '★ Fisher Transform turns', on: false },
  {tier: 'A', n: 'Squeeze', d: '★ TTM squeeze release', on: true }, {tier: 'B', n: 'CRSI', d: '★ Connors RSI mean-rev', on: false },
  { cat: 'B · Institutional Order Flow & Smart Money' },
  {tier: 'A', n: 'VWAPBands', d: '★ VWAP ±1–3σ deviation bands', on: true }, {tier: 'C', n: 'CVD', d: '★ Cumulative Volume Delta divergence', on: false },
  {tier: 'C', n: 'FVG', d: '★ Fair Value Gap / imbalance taps', on: false },
  {tier: 'C', n: 'Regime', d: '★ Choppiness gate for trend loops', on: false },
  { cat: 'C · Pure price/volume oscillators (new)' },
  {tier: 'C', n: 'Chop', d: '★ Choppiness consolidation filter', on: false }, {tier: 'C', n: 'Cyber', d: '★ Ehlers cycle turning points', on: false },
  {tier: 'C', n: 'VWMA', d: '★ Volume-weighted MA trend', on: false }, {tier: 'B', n: 'CMO', d: '★ Chande momentum exhaustion', on: false },
  {tier: 'B', n: 'Aroon', d: '★ Time-between-highs trend', on: false },
  { cat: 'D · Combinatorial presets (multi-leg)' },
  {tier: 'A', n: 'SqueezeBreak', d: '★P Squeeze + volume + CK stops', on: true }, {tier: 'B', n: 'TrendRegime', d: '★P Chop gate + ST + MACD', on: false },
  {tier: 'A', n: 'VWAPRev', d: '★P VWAP fade + CMO trigger', on: true },
  { cat: 'E · Regime-first DSP (Ehlers) + cycle-adaptive' },
  {tier: 'A', n: 'ITrend', d: '★ Ehlers InstantTrend vs trigger', on: true }, {tier: 'A', n: 'AdaptRSI', d: '★ cycle-adaptive RSI (Hilbert)', on: true },
  {tier: 'B', n: 'AdaptBB', d: '★ cycle-adaptive Bollinger (Hilbert)', on: false }, {tier: 'C', n: 'HilbertDC', d: '★ dominant-cycle overlay (no trades)', on: false },
  { cat: 'F · Expansion: ribbon / slope / patterns / volume / regime legs' },
  {tier: 'B', n: 'Ribbon', d: 'Trend · EMA ribbon stack', on: false }, {tier: 'B', n: 'VWAPSlope', d: 'Trend · session VWAP slope', on: false },
  {tier: 'B', n: 'MACDSlope', d: 'Momentum · MACD hist slope', on: false }, {tier: 'B', n: 'ADXDI', d: 'Trend · ADX + DI cross', on: false },
  {tier: 'C', n: 'LRSlope', d: 'Trend · lin-reg slope', on: false },
  {tier: 'B', n: 'PctB', d: 'Mean-rev · Bollinger %B', on: false }, {tier: 'B', n: 'VWAPDev', d: 'Mean-rev · VWAP deviation', on: false },
  {tier: 'C', n: 'ATRPct', d: 'Vol · ATR% expansion burst', on: false }, {tier: 'C', n: 'BBWidth', d: 'Vol · bandwidth expansion', on: false },
  {tier: 'B', n: 'ORB', d: 'Breakout · opening range + volume', on: false },
  {tier: 'B', n: 'InsideBar', d: 'Pattern · inside-bar break (1/2/3)', on: false }, {tier: 'B', n: 'NR7', d: 'Pattern · narrow-range break', on: false },
  {tier: 'C', n: 'VolRate', d: 'Volume · vol-confirmed trend', on: false }, {tier: 'C', n: 'VolSpike', d: 'Volume · spike burst', on: false },
  {tier: 'C', n: 'VolReg', d: 'Regime · BB-width percentile gate', on: false }, {tier: 'C', n: 'KaufER', d: 'Regime · efficiency-ratio gate', on: false },
  {tier: 'C', n: 'DecaySlope', d: 'Options · premium decay slope (not theta)', on: false },
  {tier: 'B', n: 'TrendFollow', d: '★P Ribbon + SuperTrend + ADX + vol', on: false }, {tier: 'B', n: 'VWAPMR', d: '★P VWAP + RSI (CE↓/PE↑ map)', on: false },
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
  HilbertDC: {},
  ITrend: { alpha: [0.03, 0.15, 0.02] },
  AdaptRSI: { baseLen: [8, 20, 2], oversold: [20, 30, 10], overbought: [70, 80, 10] },
  AdaptBB: { baseLen: [15, 30, 5], mult: [1.5, 2.5, 0.5] },
  Ribbon: { fast: [3, 8, 1], med: [8, 21, 1], slow: [21, 55, 1] },
  VWAPSlope: { slopeLen: [3, 10, 1] },
  MACDSlope: { fast: [8, 12, 4], slow: [21, 26, 5], signal: [5, 9, 4], slopeLen: [2, 5, 1] },
  ADXDI: { length: [10, 20, 5], threshold: [20, 30, 5] },
  LRSlope: { length: [10, 20, 5] },
  PctB: { length: [10, 20, 5], mult: [1.5, 2, 0.5], lo: [0.1, 0.2, 0.1], hi: [0.8, 0.9, 0.1] },
  VWAPDev: { thresh: [0.5, 2, 0.5] },
  ATRPct: { length: [10, 20, 5], mult: [1.2, 2, 0.2], emaLen: [10, 30, 10] },
  BBWidth: { length: [10, 20, 5], mult: [1.2, 2, 0.2], lookback: [50, 200, 50] },
  ORB: { rangeMin: [15, 45, 15], volMult: [2, 4, 1] },
  InsideBar: { mode: [1, 3, 1] },
  NR7: { ibOnly: [0, 1, 1] },
  VolRate: { length: [10, 20, 5], mult: [1.5, 3, 0.5], emaLen: [10, 30, 10] },
  VolSpike: { length: [10, 20, 5], mult: [1.5, 3, 0.5] },
  VolReg: { length: [10, 20, 5], lookback: [50, 200, 50], gate: [30, 60, 10], maPeriod: [20, 50, 10] },
  KaufER: { erPeriod: [10, 20, 5], trendTh: [0.25, 0.4, 0.05], rangeTh: [0.1, 0.25, 0.05], maPeriod: [10, 30, 10] },
  DecaySlope: { length: [10, 30, 10], thresh: [0.02, 0.1, 0.02] },
  TrendFollow: { fast: [5, 13, 1], med: [13, 34, 1], slow: [34, 89, 1], atrP: [7, 14, 7], stMult: [2, 3, 1], adxP: [10, 20, 5], adxTh: [20, 30, 5], useVol: [0, 1, 1], volLen: [10, 30, 10], volMult: [1.5, 3, 0.5] },
  VWAPMR: { sd1: [1, 2, 1], sd2: [2, 3, 1], rsiP: [7, 21, 7], oversold: [20, 40, 10], overbought: [60, 80, 10] },
};

export const TFS = [1, 2, 3, 4, 5, 7, 10, 15];
export const EXIT_LBL: Record<string, string> = { fixed: 'FIX', breakeven: 'BE', atr: 'ATR', atrTP: 'ATR-TP', ck: 'CK' };

// Intraday window buckets in IST clock-minutes. b1–b4 cover the NSE session;
// b5–b8 are opt-in subdivisions (union semantics — defaults ≡ full coverage).
// Non-NSE exchanges bypass windows entirely (their hours differ).
export const WIN_MAP: Record<string, [number, number]> = {
  b1: [555, 600], b2: [600, 720], b3: [720, 840], b4: [840, 930],
  b5: [600, 660], b6: [660, 720], b7: [840, 900], b8: [900, 915],
};

// Realistic per-trade cost/lot presets (brokerage + STT + charges, per lot).
// Zero-cost runs can never pass the paper gate — pick a preset before running.
export const COST_PRESETS: Record<string, { cost: number; lot: number; label: string }> = {
  NIFTY_FUT: { cost: 20, lot: 75, label: 'Nifty futures · ₹20/lot' },
  BANKNIFTY_FUT: { cost: 40, lot: 25, label: 'BankNifty futures · ₹40/lot' },
  NIFTY_OPT: { cost: 60, lot: 75, label: 'Nifty options · ₹60/lot' },
  BANKNIFTY_OPT: { cost: 60, lot: 25, label: 'BankNifty options · ₹60/lot' },
};

export type ExecOpts = {
  direction: string; sessionStart: string | null; sessionEnd: string | null;
  slPct: number; tpPct: number; trailPct: number; capital: number;
  qty: number; lotSize: number; cost: number;
  beTrigger: number; beLock: number; atrTrailPeriod: number; atrTrailMult: number;
  ckPeriod: number; ckMult: number; fill: string; entry: string;
};
