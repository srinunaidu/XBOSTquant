import React, { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import engine, { type BoardRow } from '../lib/engine';
import { EXIT_LBL } from '../lib/config';
import { useStore } from '../lib/store';
import { fmtMoney, fmtParams } from '../lib/format';
import { selectRow } from '../lib/runner';

ModuleRegistry.registerModules([AllCommunityModule]);

const darkTheme = themeQuartz.withParams({
  backgroundColor: '#0e0e13',
  headerBackgroundColor: '#141419',
  oddRowBackgroundColor: '#101016',
  borderColor: '#232329',
  rowHoverColor: '#17171f',
  selectedRowBackgroundColor: 'rgba(52,211,153,.10)',
  foregroundColor: '#f4f4f5',
  fontFamily: ['Geist Mono', 'monospace'],
  fontSize: 12,
});

function rowToObj(r: BoardRow, ix: number) {
  const m = r.m;
  return {
    ix: ix + 1, tf: r.timeframe + 'm', ind: r.indicator + (r.refined ? ' 🔁' : ''),
    params: fmtParams(r.params),
    exit: EXIT_LBL[r.exit || 'fixed'] || 'FIX', sess: r.carry ? 'CRY' : 'DAY',
    sl: (r.slPct || 0).toFixed(2), tp: (r.tpPct || 0).toFixed(2),
    pnl: m.netPnL, wr: m.winRate, n: m.totalTrades, tpd: m.tradesPerDay || 0,
    pf: m.profitFactor, dd: m.maxDD, sh: m.sharpe, so: m.sortino,
    _r: r,
  };
}

const COLS = [
  { field: 'ix', headerName: '#', width: 52 },
  { field: 'tf', headerName: 'TF', width: 62 },
  { field: 'ind', headerName: 'Strategy', minWidth: 130, flex: 1 },
  { field: 'params', headerName: 'Params', minWidth: 200, flex: 2 },
  { field: 'exit', headerName: 'Exit', width: 70 },
  { field: 'sess', headerName: 'Sess', width: 66 },
  { field: 'sl', headerName: 'SL %', width: 76, type: 'rightAligned' },
  { field: 'tp', headerName: 'TP %', width: 76, type: 'rightAligned' },
  { field: 'pnl', headerName: 'Net P&L ₹', width: 110, type: 'rightAligned', valueFormatter: (p: any) => fmtMoney(p.value), cellStyle: (p: any) => ({ color: p.value >= 0 ? '#22ff88' : '#fb4d6d' }) },
  { field: 'wr', headerName: 'WR %', width: 76, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(1) },
  { field: 'n', headerName: 'Trades', width: 80, type: 'rightAligned' },
  { field: 'tpd', headerName: 'T/Day', width: 72, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(1) },
  { field: 'pf', headerName: 'PF', width: 70, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) },
  { field: 'dd', headerName: 'MaxDD %', width: 92, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2), cellStyle: { color: '#fb4d6d' } },
  { field: 'sharpe', headerName: 'Sharpe', width: 82, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) },
  { field: 'so', headerName: 'Sortino', width: 82, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) },
];

export default function Leaderboard() {
  const board = useStore(s => s.board);
  const view = useStore(s => s.view);
  const set = useStore(s => s.set);
  const boardFilter = useStore(s => s.boardFilter);
  const objective = useStore(s => s.objective);
  const sel = useStore(s => s.sel);

  const rows = useMemo(() => {
    const q = boardFilter.toLowerCase();
    let list = board.filter(r =>
      !q || (r.indicator + ' ' + r.timeframe + ' ' + fmtParams(r.params) + ' ' + (r.exit || '') + (r.carry ? ' carry' : '')).toLowerCase().includes(q));
    if (view === 'best') {
      const ranked = engine.rankResults(board, objective);
      const seen = new Set<string>(), out: BoardRow[] = [];
      for (const r of ranked) if (!seen.has(r.indicator)) { seen.add(r.indicator); out.push(r); }
      const champ = new Set(out);
      list = list.filter(r => champ.has(r)).sort((a, b) => out.indexOf(a) - out.indexOf(b));
    }
    return list.map(rowToObj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, view, boardFilter, objective]);

  return (
    <section className="card p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-display font-semibold text-[14px] tracking-tight">🏆 Master Leaderboard <span className="text-zinc-500 font-normal text-xs">— click any row to load it on the charts</span></div>
        <div className="flex gap-1 ml-2">
          {([['all', '📋 All results'], ['best', '🏆 Best per indicator'], ['cmp', '⚖ Compare exits']] as const).map(([v, l]) => (
            <button key={v} onClick={() => set({ view: v })}
              className={view === v ? 'btn-run !py-1 !px-2.5 !text-[11px]' : 'btn-ghost btn-xs'}>{l}</button>
          ))}
        </div>
        <input placeholder="filter e.g. EMA 5m…" value={boardFilter}
          onChange={e => set({ boardFilter: e.target.value })}
          className="ml-auto !text-xs !py-1.5 px-2 w-52" />
      </div>
      {view === 'best' && <div className="text-[11px] text-green-300 num mb-2">★ One champion row per indicator for the current objective — full details in every column.</div>}
      {view === 'cmp' ? (
        <CompareView />
      ) : (
        <div className="ag-theme-xbost" style={{ height: 380, width: '100%' }}>
          <AgGridReact
            theme={darkTheme}
            rowData={rows}
            columnDefs={COLS as any}
            rowSelection="single"
            onRowClicked={e => selectRow((e.data as any)._r)}
            getRowId={p => String((p.data as any)._r.i) + (p.data as any)._r.indicator}
            animateRows={false}
          />
        </div>
      )}
      {!rows.length && view !== 'cmp' && (
        <div className="empty-state">Upload a 1-min CSV to populate terminal strategies…</div>
      )}
    </section>
  );
}

function CompareView() {
  const board = useStore(s => s.board);
  const objective = useStore(s => s.objective);
  const champs = (() => {
    const ranked = engine.rankResults(board, objective);
    const seen = new Set<string>(), out: BoardRow[] = [];
    const key = (r: BoardRow) => `${EXIT_LBL[r.exit || 'fixed'] || 'FIX'}${r.carry ? '+carry' : ' intraday'}`;
    for (const r of ranked) { const k = key(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out;
  })();
  if (!champs.length) return <div className="empty-state">Run a grid search to compare exit profiles…</div>;
  return (
    <div>
      <div className="text-[11px] text-amber-300 num mb-2">{board.length} combos ranked by {objective}</div>
      <div className="overflow-auto max-h-[300px] border border-[#232329] rounded-lg mb-2">
        <table className="w-full min-w-[1150px] text-[12px] num">
          <thead className="bg-[#141419] sticky top-0">
            <tr className="text-[10px] uppercase tracking-wider text-zinc-400">
              <th className="p-2 text-left">#</th><th className="p-2 text-left">Exit profile</th><th className="p-2 text-right">TF</th>
              <th className="p-2 text-left">Strategy</th><th className="p-2 text-left">Params</th><th className="p-2 text-right">SL %</th>
              <th className="p-2 text-right">TP %</th><th className="p-2 text-right">Net P&L ₹</th><th className="p-2 text-right">WR %</th>
              <th className="p-2 text-right">Trades</th><th className="p-2 text-right">PF</th><th className="p-2 text-right">MaxDD %</th><th className="p-2 text-right">Sharpe</th>
            </tr>
          </thead>
          <tbody>
            {champs.map((r, ix) => (
              <tr key={ix} className="border-t border-[#1b1b22] hover:bg-[#17171f] cursor-pointer" onClick={() => selectRow(r)}>
                <td className="p-2">{ix + 1}</td>
                <td className="p-2">{EXIT_LBL[r.exit || 'fixed']}{r.carry ? ' + carry' : ' intraday'}</td>
                <td className="p-2 text-right">{r.timeframe}m</td>
                <td className="p-2">{r.indicator}</td>
                <td className="p-2">{fmtParams(r.params)}</td>
                <td className="p-2 text-right">{(r.slPct || 0).toFixed(2)}</td>
                <td className="p-2 text-right">{(r.tpPct || 0).toFixed(2)}</td>
                <td className={`p-2 text-right ${r.m.netPnL >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(r.m.netPnL)}</td>
                <td className="p-2 text-right">{r.m.winRate.toFixed(1)}</td>
                <td className="p-2 text-right">{r.m.totalTrades}</td>
                <td className="p-2 text-right">{r.m.profitFactor.toFixed(2)}</td>
                <td className="p-2 text-right neg">{r.m.maxDD.toFixed(2)}</td>
                <td className="p-2 text-right">{r.m.sharpe.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CmpEquity champs={champs} />
    </div>
  );
}

function CmpEquity({ champs }: { champs: BoardRow[] }) {
  const data = useStore(s => s.data);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ref.current || !data || !champs.length) return;
    let chart: any;
    (async () => {
      const LC = await import('lightweight-charts');
      chart = LC.createChart(ref.current!, {
        layout: { background: { color: 'transparent' }, textColor: '#8b8b96' },
        grid: { vertLines: { color: 'rgba(46,46,54,.35)' }, horzLines: { color: 'rgba(46,46,54,.35)' } },
        height: 260,
      });
      const colors = ['#22ff88', '#38bdf8', '#facc15', '#f472b6', '#c084fc', '#fb923c'];
      champs.slice(0, 6).forEach((r, di) => {
        const det = runDetailForChart(r);
        if (!det) return;
        const stride = Math.max(1, Math.floor(det.d.t.length / 1500));
        const pts: any[] = [];
        for (let i = 0; i < det.d.t.length; i += stride) {
          pts.push({ time: Math.floor(det.d.t[i] / 1000) as any, value: +det.bt.equity[i].toFixed(0) });
        }
        const ls = chart.addLineSeries({ color: colors[di % colors.length], lineWidth: 2, priceFormat: { type: 'volume' } });
        ls.setData(pts);
      });
      chart.timeScale().fitContent();
    })();
    return () => { try { chart?.remove(); } catch { /* noop */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [champs, data]);
  return (
    <div>
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">📊 Champion equity overlay <span className="text-zinc-500 font-normal text-xs">— one curve per exit profile</span></div>
      <div ref={ref} />
    </div>
  );
}

// synchronous detail backtest (no store write) for overlay curves
function runDetailForChart(r: BoardRow) {
  const st = useStore.getState();
  if (!st.data) return null;
  const d = engine.resample(st.data, r.timeframe);
  const sig = engine.buildSignals(d, { indicator: r.indicator, params: r.params });
  const base = {
    direction: 'Both', sessionStart: st.useSession ? st.sessStart : null, sessionEnd: st.useSession ? st.sessEnd : null,
    slPct: r.slPct ?? 0.8, tpPct: r.tpPct ?? 1.6, trailPct: st.trail, capital: st.capital, qty: st.qty, lotSize: st.lot,
    cost: st.cost, beTrigger: st.beTrigger, beLock: st.beLock, atrTrailPeriod: st.atrP, atrTrailMult: st.atrM,
    ckPeriod: st.ckP, ckMult: st.ckM, fill: st.fill, entry: st.entry,
    exit: r.exit || 'fixed', carry: !!r.carry,
  };
  const xo = engine.exitOptsFromParams(r.indicator, r.params || {});
  if (xo) { (base as any).ckPeriod = xo.ckPeriod; (base as any).ckMult = xo.ckMult; }
  (base as any).sessionMask = (base as any).carry ? new Int8Array(d.c.length).fill(1) : engine.buildSessionMask(d, (base as any).sessionStart, (base as any).sessionEnd);
  const bt = engine.backtest(d, sig.pos, base);
  return { d, bt };
}

