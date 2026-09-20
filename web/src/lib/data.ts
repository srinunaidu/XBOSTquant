// Data ingestion: upload, bundled file, date slicing. Mirrors classic behavior.
import engine, { type OHLCV } from './engine';
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
  if (onProgress) onProgress(60);
  const t0 = performance.now();
  const d = engine.parseCSV(text);
  if (!d.t.length) throw new Error('no valid OHLCV rows found');
  let sym = d.symbol;
  if (!sym) {
    const base = f.name.replace(/\.[^.]+$/, '');
    sym = (base.split(/[_.\-\s]+/)[0] || base).toUpperCase().slice(0, 20) || 'DATA';
  }
  const datasets = { ...st.datasets, [sym]: { raw: d, label: f.name, enabled: true } };
  st.set({ datasets, symbol: sym });
  setData(d, f.name + ' · real');
  logLine(`loaded ${f.name} as ${sym}: ${(d.t.length / 1000).toFixed(0)}k rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  if (onProgress) onProgress(100);
}

