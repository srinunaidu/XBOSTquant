// Data ingestion: upload, bundled file, date slicing. Mirrors classic behavior.
import engine, { type OHLCV } from './engine';
import { useStore } from './store';
import { logLine } from './runner';

function pick(a: Float64Array, idx: number[]) {
  const out = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = a[idx[i]];
  return out;
}

export function applyDateFilter() {
  const st = useStore.getState();
  const d = st.raw;
  if (!d) return;
  if (!st.fromDate && !st.toDate) {
    if (st.data !== d) st.set({ data: d });
    return;
  }
  const lo = st.fromDate ? new Date(st.fromDate + 'T00:00:00').getTime() : -Infinity;
  const hi = st.toDate ? new Date(st.toDate + 'T23:59:59').getTime() : Infinity;
  const idx: number[] = [];
  for (let i = 0; i < d.t.length; i++) if (d.t[i] >= lo && d.t[i] <= hi) idx.push(i);
  st.set({
    data: { t: pick(d.t, idx), o: pick(d.o, idx), h: pick(d.h, idx), l: pick(d.l, idx), c: pick(d.c, idx), v: pick(d.v, idx) },
    dataInfo: `Filtered: ${idx.length.toLocaleString()} bars`,
  });
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

function symbolFromFile(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  return ((base.split(/[_.\-\s]+/)[0] || base).toUpperCase().slice(0, 20));
}

export async function loadFile(f: File, onProgress?: (p: number) => void): Promise<void> {
  const st = useStore.getState();
  const text = await f.text();
  if (onProgress) onProgress(60);
  const t0 = performance.now();
  const d = engine.parseCSV(text);
  if (!d.t.length) throw new Error('no valid OHLCV rows found');
  if (d.symbol) st.set({ symbol: d.symbol });
  else { const sym = symbolFromFile(f.name); if (sym) st.set({ symbol: sym }); }
  setData(d, f.name + ' · real');
  logLine(`loaded ${f.name}: ${(d.t.length / 1000).toFixed(0)}k rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  if (onProgress) onProgress(100);
}

export async function loadRepoCSV(): Promise<void> {
  const st = useStore.getState();
  st.set({ dataInfo: 'fetching HDFCBANK_minute.csv…' });
  const r = await fetch('HDFCBANK_minute.csv');
  if (!r.ok) throw new Error('HTTP ' + r.status + ' — upload your own 1-min CSV instead');
  const txt = await r.text();
  const t0 = performance.now();
  const d = engine.parseCSV(txt);
  if (!d.t.length) throw new Error('empty file');
  if (!st.symbol) st.set({ symbol: d.symbol || 'HDFCBANK' });
  setData(d, 'HDFCBANK_minute.csv · real');
  logLine(`loaded repo file: ${(d.t.length / 1000).toFixed(0)}k rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
