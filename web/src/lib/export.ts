import { useStore } from './store';
import { fmtIST, fmtParams } from './format';

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
  let s = 'rank,timeframe,indicator,params,exit,carry,sl_pct,tp_pct,net_pnl,win_rate,trades,trades_per_day,profit_factor,max_dd,sharpe,sortino,expectancy\n';
  st.board.forEach((r, i) => {
    s += `${i + 1},${r.timeframe}m,${r.indicator},"${fmtParams(r.params)}",${r.exit || 'fixed'},${r.carry ? 1 : 0},${(r.slPct || 0).toFixed(3)},${(r.tpPct || 0).toFixed(3)},${r.m.netPnL.toFixed(2)},${r.m.winRate.toFixed(2)},${r.m.totalTrades},${(r.m.tradesPerDay || 0).toFixed(3)},${r.m.profitFactor.toFixed(3)},${r.m.maxDD.toFixed(3)},${r.m.sharpe.toFixed(3)},${r.m.sortino.toFixed(3)},${r.m.expectancy.toFixed(2)}\n`;
  });
  dl('xbost_leaderboard.csv', s);
}

export function exportTrades() {
  const st = useStore.getState();
  if (!st.detail) { st.set({ alert: 'No strategy loaded — run a search and click any leaderboard row.' }); return; }
  const { bt } = st.detail;
  const r = st.sel!;
  let s = 'id,entry_time_ist,exit_time_ist,type,entry_px,exit_px,pnl,pnl_pct,reason\n';
  for (const t of bt.trades) {
    s += `${t.id},${fmtIST(t.entryTime)},${fmtIST(t.exitTime)},${t.type},${t.entryPx},${t.exitPx},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.reason}\n`;
  }
  dl(`xbost_trades_${r.indicator}_${r.timeframe}m_${r.exit || 'fixed'}${r.carry ? '_carry' : ''}_SL${r.slPct || 0}_TP${r.tpPct || 0}.csv`, s);
}

export function downloadLog() {
  const st = useStore.getState();
  if (!st.log.length) { st.set({ alert: 'Session log is empty — run validation or a grid search first.' }); return; }
  dl(`xbost_log_${st.symbol || 'data'}_${new Date().toISOString().slice(0, 10)}.txt`,
    `XBOST run log · ${new Date().toString()}\n${'='.repeat(60)}\n` + st.log.join('\n') + '\n');
}
