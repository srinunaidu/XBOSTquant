import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { useStore } from '../lib/store';
import { fmtMoney, fmtT } from '../lib/format';

ModuleRegistry.registerModules([AllCommunityModule]);

const darkTheme = themeQuartz.withParams({
  backgroundColor: '#0e0e13',
  headerBackgroundColor: '#141419',
  oddRowBackgroundColor: '#101016',
  borderColor: '#232329',
  rowHoverColor: '#17171f',
  foregroundColor: '#f4f4f5',
  fontFamily: ['Geist Mono', 'monospace'],
  fontSize: 12,
});

export default function TradeLog() {
  const detail = useStore(s => s.detail);
  const cost = useStore(s => s.cost);
  const capital = useStore(s => s.capital);

  if (!detail) {
    return (
      <section className="card p-3">
        <Title count="" />
        <div className="empty-state">No strategy loaded — run a search and click any row…</div>
      </section>
    );
  }
  const { bt } = detail;
  const m = bt.metrics;
  // running capital per visible row (forward)
  const shown = bt.trades.slice(-500);
  const prefix = bt.trades.length > 500 ? bt.trades.slice(0, -500).reduce((s, t) => s + t.pnl, 0) : 0;
  let c0 = capital + prefix;
  const withCap = shown.map(t => { c0 += t.pnl; return { ...t, cap: Math.round(c0) }; });

  return (
    <section className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="font-display font-semibold text-[14px] tracking-tight">
          🧾 Trade Analytics &amp; Log <span className="text-zinc-500 font-normal text-xs num">· {bt.trades.length} closed trades</span>
          <span className="text-zinc-600 font-normal text-[10px]"> · red edge = exited inside max-DD window</span>
        </div>
        <div className="ml-auto text-[11px] text-zinc-500 num">
          avg {fmtMoney(m.expectancy)} / trade · {(m.tradesPerDay || 0).toFixed(1)} trades/day · costs {fmtMoney(-(bt.trades.length * cost))} · gross +{fmtMoney(m.grossProfit)} / -{fmtMoney(m.grossLoss)}
        </div>
      </div>
      <div className="ag-theme-xbost" style={{ height: 420, width: '100%' }}>
        <AgGridReact
          theme={darkTheme}
          rowData={withCap}
          columnDefs={[
            { field: 'id', headerName: 'ID', width: 60 },
            { field: 'entryTime', headerName: 'Entry Time', width: 150, valueFormatter: (p: any) => fmtT(p.value) },
            { field: 'exitTime', headerName: 'Exit Time', width: 150, valueFormatter: (p: any) => fmtT(p.value) },
            { field: 'type', headerName: 'Type', width: 80, cellStyle: (p: any) => ({ color: p.value === 'LONG' ? '#22ff88' : '#ff3b5c' }) },
            { field: 'entryPx', headerName: 'Entry', width: 90, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) },
            { field: 'exitPx', headerName: 'Exit', width: 90, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) },
            { field: 'pnl', headerName: 'P&L ₹', width: 100, type: 'rightAligned', valueFormatter: (p: any) => (p.value >= 0 ? '+' : '') + (+p.value).toFixed(0), cellStyle: (p: any) => ({ color: p.value >= 0 ? '#22ff88' : '#fb4d6d' }) },
            { field: 'pnlPct', headerName: 'P&L %', width: 90, type: 'rightAligned', valueFormatter: (p: any) => (+p.value).toFixed(2) + '%' },
            { field: 'reason', headerName: 'Reason', width: 110 },
            { field: 'cap', headerName: 'Capital', width: 110, type: 'rightAligned', valueFormatter: (p: any) => '₹' + (+p.value).toLocaleString('en-IN') },
          ] as any}
          rowClassRules={{
            'ag-dd-row': (p: any) => {
              const t = p.data, mm = detail.bt.metrics;
              return mm.maxDD < 0 && t.exitTime >= mm.ddPeakTime && t.exitTime <= mm.ddTroughTime;
            },
          }}
        />
      </div>
      <style>{`.ag-theme-xbost .ag-dd-row { box-shadow: inset 2px 0 0 #fb4d6d; }`}</style>
    </section>
  );
}

function Title({ count }: { count: string }) {
  return (
    <div className="font-display font-semibold text-[14px] tracking-tight">
      🧾 Trade Analytics &amp; Log <span className="text-zinc-500 font-normal text-xs num">{count}</span>
    </div>
  );
}
