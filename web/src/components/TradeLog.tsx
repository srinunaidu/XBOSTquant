import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import engine from '../lib/engine';
import { useStore } from '../lib/store';
import { fmtMoney, fmtT } from '../lib/format';

ModuleRegistry.registerModules([AllCommunityModule]);

const REG_NAMES = ['T+', 'T-', 'RH', 'RL'];

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
  // ML decision per trade: regime (+confidence) of the ENTRY bar under the
  // run's routing settings. -1 = fallback day, -2 = routing off.
  const regInfo = useMemo(() => {
    if (!detail) return null;
    const st = useStore.getState();
    const d = detail.data;
    const n = d.t.length;
    const regOf = new Int8Array(n).fill(-2);
    const confOf = new Float64Array(n).fill(NaN);
    if (!st.regimeOn) return { regOf, confOf, label: 'off' };
    const gate = (st.confGate ?? 60) / 100;
    if ((st.granularity || 'day') === 'day') {
      const rt = engine.dayRouting(d, { source: st.regimeSource, confGate: gate });
      if (rt.dayReg) {
        rt.dayReg.segs.forEach((sg, si) => {
          const r = rt.dayReg!.pred[si];
          const fb = r < 0 || (rt.dayReg!.conf && rt.dayReg!.conf[si] < gate);
          for (let i = sg.s; i < sg.e && i < n; i++) { regOf[i] = fb ? -1 : r; confOf[i] = rt.dayReg!.conf ? rt.dayReg!.conf[si] : NaN; }
        });
      }
      return { regOf, confOf, label: st.regimeSource + '/day' };
    }
    const regs = st.regimeSource === 'ml'
      ? Int8Array.from(engine.trainRegimeML(d, 0.7, 15, 200).pred)
      : engine.regimeSeries(d, {});
    for (let i = 0; i < n; i++) regOf[i] = regs[i];
    return { regOf, confOf, label: st.regimeSource + '/bar' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

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
  const regLbl = (idx: number) => {
    if (!regInfo) return '—';
    const r = regInfo.regOf[Math.min(regInfo.regOf.length - 1, Math.max(0, idx))];
    return r < -1 ? '—' : r < 0 ? 'FB' : REG_NAMES[r];
  };
  const confLbl = (idx: number) => {
    if (!regInfo) return '';
    const c = regInfo.confOf[Math.min(regInfo.confOf.length - 1, Math.max(0, idx))];
    return isFinite(c) ? (c * 100).toFixed(0) + '%' : '';
  };
  const withCap = shown.map(t => { c0 += t.pnl; return { ...t, cap: Math.round(c0), regime: regLbl(t.entryIdx), conf: confLbl(t.entryIdx) }; });

  return (
    <section className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="font-display font-semibold text-[14px] tracking-tight">
          🧾 Trade Analytics &amp; Log <span className="text-zinc-500 font-normal text-xs num">· {bt.trades.length} closed trades</span>
          <span className="text-zinc-600 font-normal text-[10px]"> · red edge = exited inside max-DD window · regime = {regInfo ? regInfo.label : '—'}</span>
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
            { field: 'mae', headerName: 'MAE ₹', width: 90, type: 'rightAligned', valueFormatter: (p: any) => (+p.value || 0).toFixed(0) },
            { field: 'mfe', headerName: 'MFE ₹', width: 90, type: 'rightAligned', valueFormatter: (p: any) => (+p.value || 0).toFixed(0) },
            { field: 'regime', headerName: 'Regime', width: 76 },
            { field: 'conf', headerName: 'ML conf', width: 80, type: 'rightAligned' },
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
