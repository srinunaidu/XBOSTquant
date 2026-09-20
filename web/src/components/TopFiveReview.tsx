import { useStore } from '../lib/store';
import { fmtMoney, fmtParams } from '../lib/format';

export default function TopFiveReview() {
  const lastRun: any = useStore(s => s.lastRun);
  const board = useStore(s => s.board);
  if (!lastRun || !lastRun.top5?.length) return null;
  const top5 = lastRun.top5;
  // also grab full metrics from board for DD/sharpe if available
  const enrich = (t: any) => {
    const r = board.find(b => b.symbol === t.sym && b.timeframe === t.tf && b.indicator === t.ind);
    return r ? { dd: r.m.maxDD, sharpe: r.m.sharpe, sl: r.slPct, tp: r.tpPct, exit: r.exit } : { dd: t.dd, sharpe: t.sharpe, sl: '—', tp: '—', exit: '—' };
  };
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">
        🏅 Top 5 performing configs — detailed review <span className="text-zinc-500 font-normal text-xs">· click any row in leaderboard for full drill-down</span>
      </div>
      <div className="overflow-auto rounded-lg border border-[#232329]">
        <table className="w-full text-[12px] num">
          <thead className="bg-[#141419] sticky top-0 text-[10px] uppercase tracking-wider text-zinc-400">
            <tr>
              <th className="p-2 text-left">#</th><th className="p-2 text-left">Symbol</th><th className="p-2 text-right">TF</th>
              <th className="p-2 text-left">Indicator</th><th className="p-2 text-left">Params</th>
              <th className="p-2 text-right">WR%</th><th className="p-2 text-right">Trades</th>
              <th className="p-2 text-right">Net P&L</th><th className="p-2 text-right">DD%</th><th className="p-2 text-right">Sharpe</th>
              <th className="p-2 text-left">Exit</th><th className="p-2 text-right">SL/TP</th>
            </tr>
          </thead>
          <tbody>
            {top5.map((t: any, i: number) => {
              const e = enrich(t);
              return (
                <tr key={i} className="border-t border-[#1b1b22] hover:bg-[#17171f]">
                  <td className="p-2">{i + 1}</td>
                  <td className="p-2 font-semibold">{t.sym}</td>
                  <td className="p-2 text-right">{t.tf}m</td>
                  <td className="p-2">{t.ind}</td>
                  <td className="p-2">{fmtParams(t.params)}</td>
                  <td className="p-2 text-right">{t.wr.toFixed(1)}</td>
                  <td className="p-2 text-right">{t.n}</td>
                  <td className={`p-2 text-right ${t.pnl >= 0 ? 'pos' : 'neg'}`}>{fmtMoney(t.pnl)}</td>
                  <td className="p-2 text-right neg">{e.dd.toFixed(2)}</td>
                  <td className="p-2 text-right">{e.sharpe.toFixed(2)}</td>
                  <td className="p-2">{e.exit}</td>
                  <td className="p-2 text-right">{typeof e.sl === 'number' ? `${e.sl}/${e.tp}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-zinc-500 mt-2">Also logged as `top1…top5` in the session log — ⬇ Download complete run log captures this table verbatim for offline review.</div>
    </section>
  );
}
