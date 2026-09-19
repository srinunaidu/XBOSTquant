import { useEffect, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import engine from '../lib/engine';
import type { Detail } from '../lib/store';

const OV_COLORS: Record<string, string> = {
  ma: '#facc15', mid: '#38bdf8', up: '#38bdf888', lo: '#38bdf888',
  vwap: '#c084fc', st: '#fb923c', poc: '#f472b6',
  ckLong: '#22ff88', ckShort: '#ff3b5c', adxMa: '#facc15',
};

const BASE_OPTS = {
  layout: { background: { color: 'transparent' }, textColor: '#8b8b96', fontFamily: 'Geist Mono, monospace', fontSize: 10 },
  grid: { vertLines: { color: 'rgba(46,46,54,.35)' }, horzLines: { color: 'rgba(46,46,54,.35)' } },
  rightPriceScale: { borderColor: '#2e2e36' },
  timeScale: { borderColor: '#2e2e36', timeVisible: true },
};

function useChart(ref: React.RefObject<HTMLDivElement | null>, height: number, build: (c: IChartApi) => void, deps: any[]) {
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { ...BASE_OPTS, height, width: ref.current.clientWidth || 800 } as any);
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current!.clientWidth || 800 }));
    ro.observe(ref.current);
    build(chart);
    return () => { ro.disconnect(); try { chart.remove(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function toTime(t: number) { return Math.floor(t / 1000) as any; }

export function PriceChart({ detail, bars, markers, overlay }: { detail: NonNullable<Detail>; bars: number; markers: boolean; overlay: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: d, sig, bt } = detail;
  useChart(ref, 420, (chart) => {
    const N = Math.min(bars, d.t.length), s0 = d.t.length - N;
    const candles: any[] = [];
    for (let i = 0; i < N; i++) {
      candles.push({ time: toTime(d.t[s0 + i]), open: d.o[s0 + i], high: d.h[s0 + i], low: d.l[s0 + i], close: d.c[s0 + i] });
    }
    const cs = chart.addCandlestickSeries({ upColor: '#22ff88', downColor: '#ff3b5c', borderVisible: false, wickUpColor: '#22ff8899', wickDownColor: '#ff3b5c99' });
    cs.setData(candles);
    if (overlay) {
      for (const k of Object.keys(sig.overlay || {})) {
        const arr = sig.overlay[k];
        const pts: any[] = [];
        for (let i = Math.max(0, s0); i < d.t.length; i++) {
          const v = arr[i];
          if (isFinite(v)) pts.push({ time: toTime(d.t[i]), value: v });
        }
        if (pts.length > 1) {
          const ls = chart.addLineSeries({ color: OV_COLORS[k] || '#e4e4e7', lineWidth: k === 'up' || k === 'lo' ? 1 : 2, priceLineVisible: false, lastValueVisible: false });
          ls.setData(pts);
        }
      }
    }
    if (markers) {
      const mk: any[] = [];
      for (const tr of bt.trades) {
        for (const [idx, isEntry] of [[tr.entryIdx, true], [tr.exitIdx, false]] as const) {
          if (idx < s0 || idx >= s0 + N) continue;
          const t = toTime(d.t[idx]);
          if (isEntry) mk.push({ time: t, position: tr.type === 'LONG' ? 'belowBar' : 'aboveBar', color: tr.type === 'LONG' ? '#22ff88' : '#ff3b5c', shape: tr.type === 'LONG' ? 'arrowUp' : 'arrowDown', text: tr.type === 'LONG' ? 'L' : 'S' });
          else mk.push({ time: t, position: 'inBar', color: '#a1a1aa', shape: 'circle', text: '' });
        }
      }
      (cs as ISeriesApi<'Candlestick'>).setMarkers(mk);
    }
    chart.timeScale().fitContent();
  }, [detail, bars, markers, overlay]);
  return <div ref={ref} className="w-full" />;
}

type Sig = NonNullable<Detail>['sig'];

function firstOsc(sig: Sig): { name: string; vals: ArrayLike<number> } | null {
  const o = sig.osc || {};
  if (o.rsi) return { name: 'RSI', vals: o.rsi };
  if (o.crsi) return { name: 'Connors RSI', vals: o.crsi };
  if (o.fisher) return { name: 'Fisher Transform', vals: o.fisher };
  if (o.sqzMom) return { name: 'Squeeze momentum', vals: o.sqzMom };
  if (o.macdHist) return { name: 'MACD hist', vals: o.macdHist };
  if (o.adx) return { name: 'ADX', vals: o.adx };
  if (o.stochK) return { name: 'Stoch %K', vals: o.stochK };
  if (o.cvd) return { name: 'Cumulative Volume Delta', vals: o.cvd };
  if (o.chop) return { name: 'Choppiness Index', vals: o.chop };
  if (o.fvgBias) return { name: 'FVG bias', vals: o.fvgBias };
  if (o.cmo) return { name: 'Chande MO', vals: o.cmo };
  if (o.aroon) return { name: 'Aroon Oscillator', vals: o.aroon };
  if (o.cyber) return { name: 'Ehlers Cyber Cycle', vals: o.cyber };
  return null;
}

export function OscPanel({ detail, bars }: { detail: NonNullable<Detail>; bars: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: d, sig } = detail;
  const found = firstOsc(sig);
  const name = found ? found.name : 'RSI (ref)';
  const vals: ArrayLike<number> = found ? found.vals : engine.rsi(d.c, 14);
  useChart(ref, 220, (chart) => {
    const N = Math.min(bars, d.t.length), s0 = d.t.length - N;
    const pts: any[] = [];
    for (let i = s0; i < d.t.length; i++) {
      const v = (vals as any)[i];
      if (v !== null && v !== undefined && isFinite(+v)) pts.push({ time: toTime(d.t[i]), value: +v });
    }
    const ls = chart.addLineSeries({ color: '#38bdf8', lineWidth: 1 });
    ls.setData(pts);
    chart.timeScale().fitContent();
  }, [detail, bars]);
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">🌊 Oscillator <span className="text-zinc-500 font-normal text-xs">· {name}</span></div>
      <div ref={ref} />
    </section>
  );
}

export function VolPanel({ detail, bars }: { detail: NonNullable<Detail>; bars: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: d } = detail;
  useChart(ref, 220, (chart) => {
    const N = Math.min(bars, d.t.length), s0 = d.t.length - N;
    const vols: any[] = [];
    for (let i = 0; i < N; i++) {
      vols.push({ time: toTime(d.t[s0 + i]), value: d.v[s0 + i], color: d.c[s0 + i] >= d.o[s0 + i] ? 'rgba(34,255,136,.55)' : 'rgba(255,59,92,.55)' });
    }
    const hs = chart.addHistogramSeries({ priceFormat: { type: 'volume' } });
    hs.setData(vols);
    chart.timeScale().fitContent();
  }, [detail, bars]);
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">📊 Volume <span className="text-zinc-500 font-normal text-xs">aligned to price timeline</span></div>
      <div ref={ref} />
    </section>
  );
}

export function EquityPanel({ detail }: { detail: NonNullable<Detail> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: d, bt } = detail;
  useChart(ref, 220, (chart) => {
    const stride = Math.max(1, Math.floor(d.t.length / 1500));
    const pts: any[] = [];
    for (let i = 0; i < d.t.length; i += stride) pts.push({ time: toTime(d.t[i]), value: +bt.equity[i].toFixed(0) });
    const ls = chart.addLineSeries({ color: '#22ff88', lineWidth: 2 });
    ls.setData(pts);
    chart.timeScale().fitContent();
  }, [detail]);
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">💰 Equity Curve</div>
      <div ref={ref} />
    </section>
  );
}

export function DrawdownPanel({ detail }: { detail: NonNullable<Detail> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: d, bt } = detail;
  useChart(ref, 220, (chart) => {
    const stride = Math.max(1, Math.floor(d.t.length / 1500));
    const pts: any[] = [];
    for (let i = 0; i < d.t.length; i += stride) pts.push({ time: toTime(d.t[i]), value: +bt.dd[i].toFixed(2) });
    const ls = chart.addLineSeries({ color: '#ff3b5c', lineWidth: 1 });
    ls.setData(pts);
    chart.timeScale().fitContent();
  }, [detail]);
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">🔻 Drawdown (underwater) <span className="text-zinc-500 font-normal text-xs">%</span></div>
      <div ref={ref} />
    </section>
  );
}
