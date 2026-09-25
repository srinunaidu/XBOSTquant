// Engine facade: engine.js is loaded as a classic script (see index.html) and
// registers window.XBOST_ENGINE. Re-exported with types for the React app.
// A prebuild sync (scripts/sync-engine.js) copies the canonical sources so
// the UI and the Web Worker always run identical quant code.
export type OHLCV = {
  t: Float64Array; o: Float64Array; h: Float64Array;
  l: Float64Array; c: Float64Array; v: Float64Array;
  symbol?: string | null; layout?: string;
  contract?: { strike: number | null; otype: string; expiry: string; expiryMs: number } | null;
};

export type Metrics = {
  netPnL: number; winRate: number; totalTrades: number; profitFactor: number;
  maxDD: number; sharpe: number; sortino: number; expectancy: number;
  finalCapital: number; grossProfit: number; grossLoss: number;
  tradesPerDay: number; days: number; ddPeakTime: number; ddTroughTime: number;
  totalCosts: number; grossPreCost: number;
};

export type Trade = {
  id: number; entryIdx: number; exitIdx: number; entryTime: number; exitTime: number;
  entryPx: number; exitPx: number; type: 'LONG' | 'SHORT';
  pnl: number; pnlPct: number; reason: string;
};

export type BoardRow = {
  i: number; timeframe: number; indicator: string; params: Record<string, any>;
  slPct: number; tpPct: number; trailPct: number;
  exit: string; carry: boolean; refined?: boolean; m: Metrics; err?: string;
  symbol: string;
  oosNet?: number; oosWR?: number; oosN?: number; survived?: boolean | null;
  oosFolds?: { net: number; wr: number; n: number; sharpe?: number; skipped: boolean }[];
  robustScore?: number; robustness?: any;
  rawRank?: number; rawObjective?: { key: string; value: number };
  pair?: boolean;
  oosSharpe?: number | null; oosDegr?: number | null;
};

export interface Engine {
  parseCSV(text: string): OHLCV;
  parseCSVAll(text: string): { symbol: string | null; full: string; d: OHLCV }[];
  resample(d: OHLCV, tfMin: number): OHLCV;
  buildSessionMask(d: OHLCV, start: string | null, end: string | null): Int8Array;
  buildWindowMask(t: Float64Array, wins: number[][]): Int8Array;
  combineMasks(a: Int8Array | null, b: Int8Array | null): Int8Array | null;
  sessionMaskFor(d: OHLCV, opts: Record<string, any>): Int8Array | null;
  rsi(close: Float64Array, p: number): Float64Array;
  buildSignals(d: OHLCV, cfg: { indicator: string; params: Record<string, any> }): {
    pos: Int8Array; overlay: Record<string, any>; osc: Record<string, any>;
  };
  backtest(d: OHLCV, sigPos: Int8Array, opts: Record<string, any>): {
    trades: Trade[]; equity: Float64Array; dd: Float64Array; metrics: Metrics;
  };
  expandRange(min: number, max: number, step: number): number[];
  buildGrid(selected: any[], risk: any, dims: any): any[];
  buildHaltonGrid(selected: any[], risk: any, dims: any, nPoints?: number): any[];
  haltonSequence(nPoints: number, dims: number): number[][];
  purgedFolds(n: number, nSplits?: number, purgeBars?: number, embargoBars?: number): { train: [number, number]; test: [number, number] }[];
  bayesianRefine(rows: BoardRow[], stepsByInd?: Record<string, Record<string, number>>, nPropose?: number): any[];
  smoothRegime(regimes: Int8Array, persist?: number, hysteresis?: number): Int8Array;
  applyMaskPersistence(mask: Int8Array, minBars?: number): Int8Array;
  hilbertDC(close: Float64Array): { period: Float64Array; mode: Int8Array };
  itrend(close: Float64Array, alpha?: number): { trend: Float64Array; trig: Float64Array };
  adaptivePeriod(base: number, cycle: number | null, min?: number, max?: number): number;
  rankResults(rows: BoardRow[], objective: string): BoardRow[];
  RESEARCH_OBJS: [string, string][];
  FAMILY: Record<string, string>;
  dteMask(d: OHLCV, minDte?: number | null, maxDte?: number | null): Int8Array;
  atmStrikes(uT: Float64Array, uC: Float64Array, strikes: number[], legs?: number): { perDay: { day: string; underlying: number; atm: number; band: number[] }[]; union: number[] };
  underlyingSignal(optD: OHLCV, undD: OHLCV, tf: number, sigCfg: { indicator: string; params: Record<string, number> }): { d: OHLCV; pos: Int8Array; aligned: number };
  researchValue(m: any, key: string): number;
  researchCmp(key: string): (a: BoardRow, b: BoardRow) => number;
  auditRankingIntegrity(allRows: BoardRow[], displayed: BoardRow[]): { objective: string; key: string; pass: boolean; maxRow: string | null; maxValue: number | null; displayed: string | null }[];
  IST_OFFSET_MS: number;
  istParts(t: number): { h: number; m: number; y: number; mo: number; day: number };
  istDayKey(t: number): string;
  istDayIndex(t: number): number;
  paperEligible(row: BoardRow, o?: { scoreThreshold?: number; requireWF?: boolean; minTrades?: number; cost?: number; allowZeroCost?: boolean }): { eligible: boolean; reasons: string[]; warnings?: string[] };
  demoteKnifeEdge(ranked: BoardRow[], pssOf: (r: BoardRow) => number | null): BoardRow[];
  parseExpiryFlex(s: any): number;
  detectExchange(symbol: string): string;
  resolveSession(exchange: string, startStr?: string | null, endStr?: string | null): { exchange: string; start: string; end: string; preset: boolean };
  EXCHANGE_SESSIONS: Record<string, { start: string; end: string }>;
  ivRankSeries(c: Float64Array, rvLen?: number, histBars?: number): { ivRank: Float64Array; insufficient: boolean };
  ivRankMask(d: OHLCV, maxRank?: number | null, rvLen?: number, histBars?: number): { mask: Int8Array; insufficient: boolean };
  buildExpiryMask(d: OHLCV, excludeExpiry?: boolean): Int8Array;
  objectiveValue(m: Metrics, objective: string): number;
  paramNeighbors(row: any, steps: any, riskSteps: any): any[];
  cfgKey(c: any): string;
  exitOptsFromParams(indicator: string, params: Record<string, number>): { ckPeriod: number; ckMult: number } | null;
  regimeSeries(d: OHLCV, o?: Record<string, number>): Int8Array;
  ROUTER: Record<string, number[]>;
  regimeMask(regimes: Int8Array, indicator: string): Int8Array;
  trainRegimeML(d: OHLCV, isFrac: number, K?: number, iters?: number, maxTrain?: number): { W: number[]; p: number; trainAcc: number; pred: number[]; n: number };
  daySegments(d: OHLCV): { s: number; e: number; label: string }[];
  dayRouting(d: OHLCV, o?: { source?: string; confGate?: number }): {
    dayReg: { segs: { s: number; e: number; label: string }[]; pred: number[]; conf: number[] } | null;
    mlAcc: number | null; notices: string[]; fallbackDays: number; ok: boolean; mlFallback?: boolean;
  };
  dayRegimeMask(d: OHLCV, dayReg: { segs: { s: number; e: number; label: string }[]; pred: number[]; conf: number[] }, indicator: string, confGate: number): { mask: Int8Array; fallbackBars: number };
  validateLayers(d: OHLCV, o?: Record<string, any>): { name: string; pass: boolean; warn: boolean; detail: string }[];
  SCHEMA: Record<string, { key: string; min: number; max: number; def: number }[]>;
}

// Lazy proxy: /engine.js is auth-guarded (401 logged out), so the bundle must
// boot WITHOUT it — the Login page needs no quant code. The engine resolves
// on first actual use (post-login), when the script serves 200.
const engine: Engine = new Proxy({} as Engine, {
  get(_t, prop) {
    const E = (window as unknown as { XBOST_ENGINE?: Engine }).XBOST_ENGINE;
    if (!E) throw new Error('XBOST_ENGINE not loaded — sign in first (engine.js is auth-guarded).');
    const v = (E as unknown as Record<string | symbol, unknown>)[prop];
    return typeof v === 'function' ? (v as Function).bind(E) : v;
  },
});
export default engine;
