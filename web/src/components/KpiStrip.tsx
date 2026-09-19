import { useStore } from '../lib/store';
import { fmtMoney } from '../lib/format';

export default function KpiStrip() {
  const detail = useStore(s => s.detail);
  const m = detail?.bt.metrics;
  const items: [string, string, boolean | null][] = m ? [
    ['Net P&L', fmtMoney(m.netPnL), m.netPnL >= 0],
    ['Win Rate', m.winRate.toFixed(1) + '%', m.winRate >= 50],
    ['Trades', String(m.totalTrades), null],
    ['Profit Factor', m.profitFactor.toFixed(2), m.profitFactor >= 1.5],
    ['Max DD', m.maxDD.toFixed(2) + '%', false],
    ['Sharpe / Sortino', m.sharpe.toFixed(2) + ' / ' + m.sortino.toFixed(2), m.sharpe > 1],
  ] : [['Net P&L', '—', null], ['Win Rate', '—', null], ['Trades', '—', null],
    ['Profit Factor', '—', null], ['Max DD', '—', null], ['Sharpe', '—', null]];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
      {items.map(([l, v, good]) => (
        <div key={l} className={`card glass p-3 relative overflow-hidden ${good === false ? 'border-l-2 border-l-red-500' : 'border-l-2 border-l-emerald-400'}`}>
          <div className="lbl">{l}</div>
          <div className={`num font-display text-xl font-bold mt-1 ${good === true ? 'pos' : good === false ? 'neg' : ''}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}
