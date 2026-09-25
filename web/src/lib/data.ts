// Data ingestion: upload, bundled file, date slicing. Mirrors classic behavior.
import engine, { type OHLCV } from './engine';

// IST day key (strategy clock, not viewer clock): matches engine istDayKey.
const istDay = (t: number) => {
  const d = new Date(t + 19800000);
  return d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate();
};
import { useStore } from './store';
import { logLine } from './runner';

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
  // largest contract first; enable only it by default (42 contracts enabled
  // would explode every run) — user ticks more deliberately. Re-uploads keep
  // existing toggles.
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

// ATM ±N auto-select: using an underlying (futures/spot) dataset, find each
// day's ATM strike and enable the union of strikes within ±legs. Needs
// contract strike meta + an underlying series; otherwise returns a reason and
// changes nothing (caller keeps largest-enabled behavior).
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
  // distinct strikes across option datasets
  const strikes = [...new Set(optNames.map(k => ds[k].raw.contract!.strike as number))].sort((a, b) => a - b);
  const wanted = new Set<number>();
  // sample underlying close per calendar day
  let lastDay = '';
  for (let i = 0; i < u.t.length; i++) {
    const day = istDay(u.t[i]);
    if (day === lastDay) continue;
    lastDay = day;
    const px = u.c[i];
    let best = strikes[0], bd = Math.abs(px - best);
    for (const s of strikes) { const d = Math.abs(px - s); if (d < bd) { bd = d; best = s; } }
    const bi = strikes.indexOf(best);
    for (let j = Math.max(0, bi - legs); j <= Math.min(strikes.length - 1, bi + legs); j++) wanted.add(strikes[j]);
  }
  const keep = optNames.filter(k => wanted.has(ds[k].raw.contract!.strike as number));
  if (!keep.length) return { enabled: [], reason: 'no contracts near underlying (stale strikes?)' };
  const nds: typeof ds = { ...ds };
  names.forEach(k => { nds[k] = { ...nds[k], enabled: keep.includes(k) }; });
  st.set({ datasets: nds });
  applyDateFilter();
  logLine(`ATM±${legs} select vs ${und}: enabled ${keep.length}/${optNames.length} contracts (${[...wanted].sort((a, b) => a - b).join(',')})`);
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
    for (let i = 0; i < d.t.length; i += step) days.add(istDay(d.t[i]));
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

