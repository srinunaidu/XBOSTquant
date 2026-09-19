// Engine facade: engine.js is loaded as a classic script (see index.html) and
// registers window.XBOST_ENGINE. Re-exported with types for the React app.
// A prebuild sync (scripts/sync-engine.js) copies the canonical sources so
// the UI and the Web Worker always run identical quant code.
export type OHLCV = {
  t: Float64Array; o: Float64Array; h: Float64Array;
  l: Float64Array; c: Float64Array; v: Float64Array;
  symbol?: string | null; layout?: string;
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
  i: number; timeframe: number; indicator: string; params: Record<string, number>;
  slPct: number; tpPct: number; trailPct: number;
  exit: string; carry: boolean; refined?: boolean; m: Metrics; err?: string;
  oosNet?: number; oosWR?: number; oosN?: number; survived?: boolean;
};

export interface Engine {
  parseCSV(text: string): OHLCV;
  resample(d: OHLCV, tfMin: number): OHLCV;
  buildSessionMask(d: OHLCV, start: string | null, end: string | null): Int8Array;
  rsi(close: Float64Array, p: number): Float64Array;
  buildSignals(d: OHLCV, cfg: { indicator: string; params: Record<string, number> }): {
    pos: Int8Array; overlay: Record<string, any>; osc: Record<string, any>;
  };
  backtest(d: OHLCV, sigPos: Int8Array, opts: Record<string, any>): {
    trades: Trade[]; equity: Float64Array; dd: Float64Array; metrics: Metrics;
  };
  expandRange(min: number, max: number, step: number): number[];
  buildGrid(selected: any[], risk: any, dims: any): any[];
  rankResults(rows: BoardRow[], objective: string): BoardRow[];
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
