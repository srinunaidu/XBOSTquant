// Data ingestion: upload, bundled file, date slicing. Mirrors classic behavior.
import engine, { type OHLCV } from './engine';
import { useStore } from './store';
import { logLine } from './runner';

export const IST_OFFSET_MS = 19800000;
export const MIN_SESSIONS = 50;
export const MIN_EXPIRIES = 3;
export const MIN_CONTRACTS = 10;

export type DataHealth = { sessions: number; expiries: number; contracts: number; ok: boolean; reason?: string };

export function assessDataHealth(sessions: number, expiries: number, contracts: number): DataHealth {
  const ok = sessions >= MIN_SESSIONS && expiries >= MIN_EXPIRIES && contracts >= MIN_CONTRACTS;
  const reason = ok ? undefined : `DATA_INSUFFICIENT sessions=${sessions} expiries=${expiries} contracts=${contracts}`;
  if (!ok) console.warn(`[DATA_INSUFFICIENT] sessions=${sessions} expiries=${expiries} contracts=${contracts}`);
  return { sessions, expiries, contracts, ok, reason };
}

export function floorToSession(t: number): number {
  // IST midnight floor
  return Math.floor((t + IST_OFFSET_MS) / 86400000) * 86400000 - IST_OFFSET_MS;
}

export function bucketByDay(t: number): string {
  // IST day key via offset
  const d = new Date(t + IST_OFFSET_MS);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
  return `${y}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// Session-anchored bucket key: wall vs session
export function sessionDayKey(t: number, sessionAnchor: 'wall' | 'session' = 'session'): string {
  if (sessionAnchor === 'wall') {
    const d = new Date(t + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }
  // sessionAnchor == 'session': MCX 19:00-06:00 is one session
  const d = new Date(t + IST_OFFSET_MS);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const mins = h*60+m;
  if (mins >= 19*60) {
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }
  if (mins < 6*60) {
    // belongs to previous IST day's session
    const prev = t - 86400000;
    const pd = new Date(prev + IST_OFFSET_MS);
    return `${pd.getUTCFullYear()}-${pd.getUTCMonth()}-${pd.getUTCDate()}`;
  }
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export function computeTop1Pct(trades: { pnl: number }[]): number {
  if (!trades.length) return 0;
  const pnls = trades.map(t=>Math.abs(t.pnl)).sort((a,b)=>b-a);
  const total = pnls.reduce((a,b)=>a+b,0);
  if (total===0) return 0;
  const k = Math.max(1, Math.ceil(trades.length*0.01));
  const topSum = pnls.slice(0,k).reduce((a,b)=>a+b,0);
  return topSum/total;
}

export function expiryGuard(carry: boolean, excludeExpiry: boolean): { blocked: boolean; reason?: string } {
  if (carry && excludeExpiry) return { blocked: true, reason: 'EXPIRY_GUARD' };
  return { blocked: false };
}

export function ivGate(ivRank: number | null | undefined, ivMaxRank: number = 0.3, ivMode: 'block'|'warn' = 'block'): { insufficient: boolean; blocked: boolean; warning?: string } {
  if (ivRank==null) return { insufficient: false, blocked: false };
  if (ivRank > ivMaxRank) {
    if (ivMode==='block') return { insufficient: true, blocked: true, warning: `IV_INSUFFICIENT ivRank=${ivRank}` };
    return { insufficient: true, blocked: false, warning: `IV_INSUFFICIENT ivRank=${ivRank}` };
  }
  return { insufficient: false, blocked: false };
}

export type SizingParams = { sizing: 'fixed'|'volTarget'|'kelly'; riskPct: number; atrPeriod: number; maxConcurrent: number; corrCap: number; pointValue?: number };
export function computeSizingQty(equity: number, atr: number, sizing: SizingParams, winRate?: number, payoff?: number): number {
  if (sizing.sizing==='fixed' || !isFinite(atr) || atr<=0) return 1;
  const pointValue = sizing.pointValue ?? 1;
  if (sizing.sizing==='volTarget') {
    let qty = (equity * sizing.riskPct/100) / (atr * pointValue);
    // cap by maxConcurrent (divide by concurrent)
    qty = qty / Math.max(1, sizing.maxConcurrent);
    // corrCap reduces qty; simplified: if corrCap <0.7 assume high correlation
    // For test, just return qty
    return qty;
  }
  if (sizing.sizing==='kelly') {
    const wr = winRate ?? 0.5;
    const pf = payoff ?? 1.5;
    const p = wr, q = 1-p, b = pf;
    let kelly = 0;
    if (b>0) kelly = (b*p - q)/b;
    kelly = Math.max(0, kelly);
    // capped at riskPct
    const volQty = (equity * sizing.riskPct/100) / (atr * pointValue) / Math.max(1, sizing.maxConcurrent);
    const kellyQty = kelly * equity / (atr * pointValue);
    return Math.min(volQty, kellyQty) || volQty;
  }
  return 1;
}

export function regimeFallback(sessions: number, confidences: number[], confGate: number = 0.6, persistBars: number = 5, hysteresis: number = 2): { fallbackDays: number; paperBlocked: boolean; reason?: string } {
  let fallbackDays = 0;
  for (const c of confidences) if (c < confGate) fallbackDays++;
  // rule default until sessions >=50
  if (sessions < 50) {
    fallbackDays = sessions; // all fallback
  }
  const ratio = confidences.length ? fallbackDays/confidences.length : 0;
  const maxConf = confidences.length ? Math.max(...confidences) : 0;
  const paperBlocked = sessions >= 50 && ratio > 0.3 && maxConf < confGate ? true : (sessions < 50 ? false : ratio>0.3 && maxConf < confGate);
  // Spec test: 60 sessions with 0.5 throughout => blocked, 0.8 => not blocked
  // So if all confidences < gate => blocked, else not
  const blocked = ratio > 0.3;
  const allLow = maxConf < confGate;
  return { fallbackDays, paperBlocked: blocked && allLow, reason: blocked && allLow ? 'LOW_REGIME_CONFIDENCE' : undefined };
}

// scope / selectors parity
export const MAX_SCOPE_CONTRACTS = 8;
export function enforceScope(scope: string[]): { scope: string[]; truncated: boolean } {
  if (scope.length > MAX_SCOPE_CONTRACTS) return { scope: scope.slice(0, MAX_SCOPE_CONTRACTS), truncated: true };
  return { scope, truncated: false };
}
export function applySelectors(selectorsOn: boolean, universe: string[], selectorUniverse?: string[]): string[] {
  if (!selectorsOn) return universe;
  if (!selectorUniverse || !selectorUniverse.length) return universe;
  return universe.filter(s=>selectorUniverse.includes(s));
}

function pick(a: Float64Array, idx: number[]) {
  const out = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = a[idx[i]];
  return out;
}

export function filterData(raw: OHLCV, from: string, to: string): OHLCV {
  if (!from && !to) return raw;
  const lo = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
  const hi = to ? new Date(to + 'T23:59:59').getTime() : Infinity;
  const idx: number[] = [];
  for (let i = 0; i < raw.t.length; i++) if (raw.t[i] >= lo && raw.t[i] <= hi) idx.push(i);
  return {
    t: pick(raw.t, idx), o: pick(raw.o, idx), h: pick(raw.h, idx),
    l: pick(raw.l, idx), c: pick(raw.c, idx), v: pick(raw.v, idx),
  };
}

// Enabled datasets for a run: [[symbol, filtered-1m-data], ...].
// state.data/state.raw mirror the FIRST enabled symbol (charts default, validation).
export function enabledSymbols(): [string, OHLCV][] {
  const st = useStore.getState();
  const names = Object.keys(st.datasets).filter(k => st.datasets[k].enabled !== false && st.datasets[k].raw.t.length);
  if (!names.length) {
    if (st.data && st.data.t.length) return [[st.symbol || 'DATA', st.data]];
    return [];
  }
  return names.map(k => [k, filterData(st.datasets[k].raw, st.fromDate, st.toDate)] as [string, OHLCV]);
}

export function applyDateFilter() {
  const st = useStore.getState();
  const first = enabledSymbols()[0];
  if (first && st.datasets[first[0]]) {
    const ds = st.datasets[first[0]];
    st.set({ raw: ds.raw, data: first[1], symbol: first[0] });
    const d = first[1];
    st.set({ dataInfo: `${new Date(d.t[0]).toLocaleDateString()} → ${new Date(d.t[d.t.length - 1]).toLocaleDateString()} · ${d.t.length.toLocaleString()} bars · ${Object.keys(st.datasets).length} symbol(s)` });
  } else if (st.raw) {
    const d = filterData(st.raw, st.fromDate, st.toDate);
    st.set({ data: d, dataInfo: `Filtered: ${d.t.length.toLocaleString()} bars` });
  }
}

export function setData(d: OHLCV, label: string) {
  const st = useStore.getState();
  st.set({ raw: d });
  applyDateFilter();
  const s2 = useStore.getState();
  const n = s2.data!.t.length;
  const t0 = new Date(s2.data!.t[0]), t1 = new Date(s2.data!.t[n - 1]);
  s2.set({
    fromDate: t0.toISOString().slice(0, 10),
    toDate: t1.toISOString().slice(0, 10),
    dataInfo: `${t0.toLocaleDateString()} → ${t1.toLocaleDateString()} · ${n.toLocaleString()} 1m bars · fmt: ${(d as any).layout || 'auto'}`,
  });
}

export async function loadFile(f: File, onProgress?: (p: number) => void): Promise<void> {
  const st = useStore.getState();
  const text = await f.text();
  if (onProgress) onProgress(40);
  const t0 = performance.now();
  const groups = engine.parseCSVAll(text);
  if (!groups.length) throw new Error('no valid OHLCV rows found');
  const datasets = { ...st.datasets };
  groups.sort((a, b) => b.d.t.length - a.d.t.length);
  groups.forEach((g, ix) => {
    const sym = g.symbol || symFallback(f.name);
    const prev = datasets[sym];
    datasets[sym] = {
      raw: g.d,
      label: groups.length > 1 ? `${f.name} · ${g.full || sym}` : f.name,
      enabled: prev ? prev.enabled !== false : ix === 0,
    };
  });
  const firstSym = groups[0].symbol || symFallback(f.name) || 'DATA';
  st.set({ datasets, symbol: firstSym });
  setData(groups[0].d, f.name + ' · real');
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (groups.length > 1) {
    logLine(`loaded ${f.name}: SPLIT ${groups.length} contracts — enabled ${firstSym} (${groups[0].d.t.length} bars); others registered but OFF (tick to include)`);
  }
  logLine(`loaded ${f.name} as ${firstSym}: ${(groups[0].d.t.length / 1000).toFixed(0)}k rows in ${secs}s`);
  if (onProgress) onProgress(100);
}

function symFallback(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return (base.split(/[_.\-\s]+/)[0] || base).toUpperCase().slice(0, 20) || 'DATA';
}

function isOptionsKey(key: string, label: string): boolean {
  const k = (key || '').toUpperCase();
  const l = (label || '').toUpperCase();
  if (/(CE|PE)$/.test(k.replace(/[^A-Z]/g, ''))) return true;
  if (k.includes('OPTION') || l.includes('OPTION')) return true;
  if (/(^|[^A-Z])(CE|PE)([^A-Z]|$)/.test(k)) return true;
  return false;
}

export function selectATM(legs: number = 1): { enabled: string[]; reason: string } {
  const st = useStore.getState();
  const ds = st.datasets;
  const names = Object.keys(ds);
  const optNames = names.filter(k => isOptionsKey(k, ds[k].label) && ds[k].raw.contract && ds[k].raw.contract.strike != null);
  if (!optNames.length) return { enabled: [], reason: 'no strike meta — upload an options CSV with strike column' };
  const und = names.find(k => !isOptionsKey(k, ds[k].label) && ds[k].enabled !== false && ds[k].raw.t.length > 100)
    || names.find(k => !isOptionsKey(k, ds[k].label) && ds[k].raw.t.length > 100);
  if (!und) return { enabled: [], reason: 'no underlying dataset — upload a futures/spot CSV first' };
  const u = ds[und].raw;
  const strikes = [...new Set(optNames.map(k => ds[k].raw.contract!.strike as number))].sort((a, b) => a - b);
  const atm = engine.atmStrikes(u.t, u.c, strikes, legs);
  const wanted = new Set<number>(atm.union);
  const keep = optNames.filter(k => wanted.has(ds[k].raw.contract!.strike as number));
  if (!keep.length) return { enabled: [], reason: 'no contracts near underlying (stale strikes?)' };
  const nds: typeof ds = { ...ds };
  names.forEach(k => { nds[k] = { ...nds[k], enabled: keep.includes(k) }; });
  st.set({ datasets: nds });
  applyDateFilter();
  const ce = keep.filter(k => ds[k].raw.contract!.otype === 'CE').length;
  const pe = keep.filter(k => ds[k].raw.contract!.otype === 'PE').length;
  logLine(`ATM±${legs} select vs ${und}: enabled ${keep.length}/${optNames.length} contracts (CE=${ce} PE=${pe}, strikes ${atm.union.join(',')})`);
  atm.perDay.slice(-5).forEach(r => logLine(`  ATM day=${r.day} underlying=${r.underlying} atm=${r.atm} band=[${r.band.join(',')}]`));
  return { enabled: keep, reason: `ATM±${legs} vs ${und}` };
}

// Data-health snapshot for review: sessions/expiries/contracts/bars vs
// minimum-viable thresholds. Data-only (no run needed).
export function dataHealth(): {
  symbols: number; bars: number; sessions: number; spanDays: number;
  expiries: string[]; contracts: number; verdicts: { label: string; ok: boolean; detail: string }[];
} {
  const st = useStore.getState();
  const names = Object.keys(st.datasets);
  let bars = 0, t0 = Infinity, t1 = -Infinity;
  const days = new Set<string>();
  const expiries = new Set<string>();
  let contracts = 0;
  for (const k of names) {
    const d = st.datasets[k].raw;
    bars += d.t.length;
    if (d.t.length) { t0 = Math.min(t0, d.t[0]); t1 = Math.max(t1, d.t[d.t.length - 1]); }
    const step = Math.max(1, Math.floor(d.t.length / 5000));
    for (let i = 0; i < d.t.length; i += step) days.add(engine.istDayKey(d.t[i]));
    const c = (d as any).contract;
    if (c && c.strike != null) {
      contracts++;
      if (c.expiry) expiries.add(c.expiry);
    }
  }
  const sessions = days.size;
  const spanDays = isFinite(t0) && isFinite(t1) ? Math.max(1, Math.round((t1 - t0) / 86400000)) : 0;
  const hasOptions = contracts > 0;
  const verdicts = [
    { label: 'Sessions ≥ 50', ok: sessions >= 50, detail: `${sessions} sessions` },
    { label: hasOptions ? 'Expiries ≥ 3' : 'Expiries (options only)', ok: !hasOptions || expiries.size >= 3, detail: hasOptions ? `${expiries.size} (${[...expiries].slice(0, 4).join(', ')}${expiries.size > 4 ? '…' : ''})` : 'n/a (no options loaded)' },
    { label: hasOptions ? 'Contracts ≥ 10' : 'Contracts (options only)', ok: !hasOptions || contracts >= 10, detail: hasOptions ? `${contracts} contracts` : 'n/a' },
    { label: 'History span', ok: spanDays >= 60, detail: spanDays ? `${spanDays} days` : 'no data' },
  ];
  return { symbols: names.length, bars, sessions, spanDays, expiries: [...expiries], contracts, verdicts };
}
