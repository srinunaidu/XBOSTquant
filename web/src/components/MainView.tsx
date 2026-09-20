import { useState } from 'react';
import { useStore, type Detail } from '../lib/store';
import { EXIT_LBL } from '../lib/config';
import { fmtMoney, fmtT } from '../lib/format';
import KpiStrip from './KpiStrip';
import Leaderboard from './Leaderboard';
import RegimeSplit from './RegimeSplit';
import RunSummary from './RunSummary';
import { DrawdownPanel, EquityPanel, OscPanel, PriceChart, VolPanel } from './ChartPanels';
import TradeLog from './TradeLog';

export default function MainView() {
  const detail = useStore(s => s.detail);
  const barsToShow = useStore(s => s.barsToShow);
  const set = useStore(s => s.set);
  const symbol = useStore(s => s.symbol);
  const [showMk, setShowMk] = useState(true);
  const [showOv, setShowOv] = useState(true);

  return (
    <main className="flex-1 min-w-0 p-3 space-y-3">
      <KpiStrip />
      <RunSummary />
      <Leaderboard />
      {detail && <RegimeSplit />}
      {detail ? (
        <>
          <section className="card p-3">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <div className="font-display font-semibold text-[14px] tracking-tight">
                📈 Price · Overlays · Signals{' '}
                <span className="text-zinc-500 font-normal text-xs num">
                  · {detail.cfg.symbol || symbol} · {detail.cfg.timeframe}m · {detail.cfg.indicator} · SL {(detail.cfg.slPct || 0).toFixed(2)}% / TP {(detail.cfg.tpPct || 0).toFixed(2)}% · {EXIT_LBL[detail.cfg.exit || 'fixed'] || 'FIX'}{detail.cfg.carry ? ' +carry' : ''}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
                <label>Bars
                  <select value={barsToShow} className="ml-1" onChange={e => set({ barsToShow: +e.target.value })}>
                    {[200, 500, 1000, 2000].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={showMk} onChange={() => setShowMk(!showMk)} /> signals</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={showOv} onChange={() => setShowOv(!showOv)} /> overlay</label>
              </div>
            </div>
            <PriceChart detail={detail} bars={barsToShow} markers={showMk} overlay={showOv} />
            <Legend detail={detail} />
          </section>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <OscPanel detail={detail} bars={barsToShow} />
            <VolPanel detail={detail} bars={barsToShow} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <EquityPanel detail={detail} />
            <DrawdownPanel detail={detail} />
          </div>
        </>
      ) : (
        <section className="card p-3">
          <div className="empty-state">Run a grid search and click any leaderboard row to render price, oscillators and equity…</div>
        </section>
      )}
      <TradeLog />
      <footer className="text-center text-[11px] text-zinc-600 pb-6">
        XBOST terminal · real 1-min OHLCV → {'{1,2,3,4,5,7,10,15}m'} resampling · Cartesian grid search in Web Worker · For research, not investment advice.
      </footer>
    </main>
  );
}

function Legend({ detail }: { detail: NonNullable<Detail> }) {
  const ov = Object.keys(detail.sig.overlay || {});
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-zinc-400 mt-2 num">
      <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-[#22ff88]" /> bull</span>
      <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-[#ff3b5c]" /> bear</span>
      {ov.map(k => <span key={k}>— {k}</span>)}
      <span className="text-zinc-500">▲/▼ entries · ○ exits · equity DD window {detail.bt.metrics.maxDD < 0
        ? `${detail.bt.metrics.maxDD.toFixed(2)}% ${fmtT(detail.bt.metrics.ddPeakTime)} → ${fmtT(detail.bt.metrics.ddTroughTime)}` : '—'}</span>
    </div>
  );
}

