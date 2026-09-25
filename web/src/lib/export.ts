import { useStore } from './store';
import engine from './engine';
import { fmtIST, fmtParams } from './format';

const REG_NAMES = ['T+', 'T-', 'RH', 'RL'];

function tradeRegimes() {
  const st = useStore.getState();
  const detail = st.detail;
  if (!detail) return null;
  const d = detail.data, n = d.t.length;
  const regOf = new Int8Array(n).fill(-2);
  const confOf = new Float64Array(n).fill(NaN);
  if (st.regimeOn) {
    const gate = (st.confGate ?? 60) / 100;
    if ((st.granularity || 'day') === 'day') {
      const rt = engine.dayRouting(d, { source: st.regimeSource, confGate: gate });
      if (rt.dayReg) rt.dayReg.segs.forEach((sg, si) => {
        const r = rt.dayReg!.pred[si];
        const fb = r < 0 || (rt.dayReg!.conf && rt.dayReg!.conf[si] < gate);
        for (let i = sg.s; i < sg.e && i < n; i++) { regOf[i] = fb ? -1 : r; confOf[i] = rt.dayReg!.conf ? rt.dayReg!.conf[si] : NaN; }
      });
    } else {
      const regs = st.regimeSource === 'ml' ? Int8Array.from(engine.trainRegimeML(d, 0.7, 15, 200).pred) : engine.regimeSeries(d, {});
      for (let i = 0; i < n; i++) regOf[i] = regs[i];
    }
  }
  return { regOf, confOf };
}

function dl(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function exportBoard() {
  const st = useStore.getState();
  if (!st.board.length) { st.set({ alert: 'Nothing to export — run a grid search first.' }); return; }
  let s = 'rank,timeframe,indicator,params,exit,carry,sl_pct,tp_pct,net_pnl,win_rate,trades,trades_per_day,profit_factor,max_dd,sharpe,sortino,expectancy,oos_net,oos_wr,oos_n,survived,oos_sharpe,oos_degr\n';
  st.board.forEach((r, i) => {
    s += `${i + 1},${r.timeframe}m,${r.indicator},"${fmtParams(r.params)}",${r.exit || 'fixed'},${r.carry ? 1 : 0},${(r.slPct || 0).toFixed(3)},${(r.tpPct || 0).toFixed(3)},${r.m.netPnL.toFixed(2)},${r.m.winRate.toFixed(2)},${r.m.totalTrades},${(r.m.tradesPerDay || 0).toFixed(3)},${r.m.profitFactor.toFixed(3)},${r.m.maxDD.toFixed(3)},${r.m.sharpe.toFixed(3)},${r.m.sortino.toFixed(3)},${r.m.expectancy.toFixed(2)},${r.oosNet == null ? '' : r.oosNet.toFixed(2)},${r.oosWR == null ? '' : r.oosWR.toFixed(2)},${r.oosN == null ? '' : r.oosN},${r.survived == null ? '' : r.survived ? 1 : 0},${r.oosSharpe == null ? '' : r.oosSharpe.toFixed(3)},${r.oosDegr == null ? '' : r.oosDegr.toFixed(3)}\n`;
  });
  dl('xbost_leaderboard.csv', s);
}

export function exportTrades() {
  const st = useStore.getState();
  if (!st.detail) { st.set({ alert: 'No strategy loaded — run a search and click any leaderboard row.' }); return; }
  const { bt } = st.detail;
  const r = st.sel!;
  let s = 'id,entry_time_ist,exit_time_ist,type,entry_px,exit_px,pnl,pnl_pct,reason,regime,ml_conf,mae,mfe,lat_bars\n';
  const ri = tradeRegimes();
  const regLbl = (idx: number) => {
    if (!ri) return '';
    const r = ri.regOf[Math.min(ri.regOf.length - 1, Math.max(0, idx))];
    return r < -1 ? '' : r < 0 ? 'FB' : REG_NAMES[r];
  };
  const confLbl = (idx: number) => {
    if (!ri) return '';
    const c = ri.confOf[Math.min(ri.confOf.length - 1, Math.max(0, idx))];
    return isFinite(c) ? (c * 100).toFixed(1) + '%' : '';
  };
  for (const t of bt.trades) {
    s += `${t.id},${fmtIST(t.entryTime)},${fmtIST(t.exitTime)},${t.type},${t.entryPx},${t.exitPx},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.reason},${regLbl(t.entryIdx)},${confLbl(t.entryIdx)},${((t as any).mae || 0).toFixed(2)},${((t as any).mfe || 0).toFixed(2)},${(t as any).lat ?? ''}\n`;
  }
  dl(`xbost_trades_${r.indicator}_${r.timeframe}m_${r.exit || 'fixed'}${r.carry ? '_carry' : ''}_SL${r.slPct || 0}_TP${r.tpPct || 0}.csv`, s);
}

export function downloadLog() {
  const st = useStore.getState();
  if (!st.log.length) { st.set({ alert: 'Session log is empty — run validation or a grid search first.' }); return; }
  dl(`xbost_log_${st.symbol || 'data'}_${new Date().toISOString().slice(0, 10)}.txt`,
    `XBOST run log · ${new Date().toString()}\n${'='.repeat(60)}\n` + st.log.join('\n') + '\n');
}

export function downloadRecoveredLog(lines: string[]) {
  if (!lines.length) return;
  dl(`xbost_log_RECOVERED_${new Date().toISOString().slice(0, 10)}.txt`,
    `XBOST RECOVERED log (survived a dead tab — last lines are where it stopped)\n${new Date().toString()}\n${'='.repeat(60)}\n` + lines.join('\n') + '\n');
}
