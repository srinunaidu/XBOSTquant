import { create } from 'zustand';
import type { BoardRow, OHLCV, Trade } from './engine';
import { DEFAULT_RANGES, IND_META, TFS } from './config';
import type { User } from './api';

export type Detail = {
  cfg: BoardRow;
  data: OHLCV;
  sig: { pos: Int8Array; overlay: Record<string, any>; osc: Record<string, any> };
  bt: { trades: Trade[]; equity: Float64Array; dd: Float64Array; metrics: BoardRow['m'] };
} | null;

export type IndState = Record<string, { on: boolean; ranges: Record<string, { min: number; max: number; step: number }> }>;

function defaultInds(): IndState {
  const out: IndState = {};
  for (const m of IND_META) {
    if (!m.n) continue;
    const ranges: IndState[string]['ranges'] = {};
    for (const [k, v] of Object.entries(DEFAULT_RANGES[m.n] || {})) {
      ranges[k] = { min: v[0], max: v[1], step: v[2] };
    }
    out[m.n] = { on: !!m.on, ranges };
  }
  return out;
}

type RunState = {
  running: boolean; done: number; total: number | string; stage: string;
  pass: number; perSec: number; eta: string; current: string; errCount: number;
  refined: number; passes: number; summary: string;
};

type State = {
  user: User | null;
  sbHide: boolean;
  symbol: string;
  raw: OHLCV | null;
  data: OHLCV | null; // date-filtered 1m (active symbol)
  datasets: Record<string, { raw: OHLCV; label: string; enabled?: boolean }>;
  fromDate: string; toDate: string;
  dataInfo: string;
  timeframes: number[];
  objective: string;
  topN: number; cap: number;
  direction: string; entry: string; fill: string;
  sessStart: string; sessEnd: string; useSession: boolean;
  slFix: number; tpFix: number; trail: number; cost: number; qty: number; lot: number;
  capital: number;
  beTrigger: number; beLock: number; atrP: number; atrM: number; ckP: number; ckM: number;
  exits: string[]; sessMode: string;
  optRisk: boolean;
  slMin: number; slMax: number; slStep: number; tpMin: number; tpMax: number; tpStep: number;
  inds: IndState;
  board: BoardRow[];
  sel: BoardRow | null;
  userPickedSeq: number;
  runSeq: number;
  stoppedFlag: boolean;
  boardTick: number;
  alert: string | null;
  _refineAt: number | null;
  _done: number;
  regimeOn: boolean;
  regimeSource: string;
  granularity: string;
  confGate: number;
  wfOn: boolean;
  wfSplit: number;
  tradeWindows: string[];
  detail: Detail;
  view: 'all' | 'best' | 'cmp';
  boardFilter: string;
  run: RunState;
  barsToShow: number;
  validation: string[];
  valOk: boolean | null;
  log: string[];
  lastRun: any | null;
  set: (p: Partial<State>) => void;
};

const initialRun: RunState = {
  running: false, done: 0, total: 0, stage: '', pass: 0,
  perSec: 0, eta: '', current: '', errCount: 0, refined: 0, passes: 0, summary: 'idle',
};

export const useStore = create<State>((set) => ({
  user: null,
  sbHide: (() => { try { return localStorage.getItem('xbost_sb') === 'hide'; } catch { return false; } })(),
  symbol: '',
  raw: null,
  data: null,
  datasets: {},
  fromDate: '', toDate: '',
  dataInfo: 'No file loaded — upload a 1-min CSV to begin.',
  timeframes: [...TFS],
  objective: 'sharpe',
  topN: 500, cap: 60000,
  direction: 'Both', entry: 'trigger', fill: 'next',
  sessStart: '09:15', sessEnd: '15:15', useSession: true,
  slFix: 0.8, tpFix: 1.6, trail: 0.5, cost: 0, qty: 1, lot: 1,
  capital: 100000,
  beTrigger: 0.5, beLock: 0, atrP: 14, atrM: 3, ckP: 10, ckM: 3,
  exits: ['fixed', 'breakeven', 'atr'], sessMode: 'intraday',
  optRisk: true,
  slMin: 0.5, slMax: 1.1, slStep: 0.3, tpMin: 1.0, tpMax: 2.0, tpStep: 0.5,
  inds: defaultInds(),
  board: [],
  sel: null,
  userPickedSeq: 0,
  runSeq: 0,
  stoppedFlag: false,
  boardTick: 0,
  alert: null,
  _refineAt: null,
  _done: 0,
  regimeOn: true,
  regimeSource: 'rules',
  granularity: 'day',
  confGate: 60,
  wfOn: false,
  wfSplit: 70,
  tradeWindows: ['b1', 'b2', 'b3', 'b4'],
  detail: null,
  view: 'all',
  boardFilter: '',
  run: { ...initialRun },
  barsToShow: 500,
  validation: [],
  valOk: null,
  log: [],
  lastRun: null,
  set: (p) => set(p),
}));

export function resetRun(): RunState {
  return { ...initialRun };
}
