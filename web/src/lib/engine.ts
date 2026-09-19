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
  SCHEMA: Record<string, { key: string; min: number; max: number; def: number }[]>;
}

const E = (window as unknown as { XBOST_ENGINE?: Engine }).XBOST_ENGINE;
if (!E) throw new Error('XBOST_ENGINE failed to load (engine.js script tag missing?)');
const engine: Engine = E;
export default engine;
