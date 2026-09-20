import { useStore } from '../lib/store';
import { fmtMoney, fmtParams } from '../lib/format';
import { downloadLog } from '../lib/export';

// Complete end-of-run summary box: config used + best + top-5 + environment.
export default function RunSummary() {
  const lastRun: any = useStore(s => s.lastRun);
  if (!lastRun) return null;
  const b = lastRun.best;
  const kv = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-3 py-[3px] border-b border-[#1b1b22] last:border-0">
      <span className="text-zinc-500">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
  return (
    <section className="card p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-display font-semibold text-[14px] tracking-tight">
          🧾 Run summary <span className="text-zinc-500 font-normal text-xs num">· {lastRun.at?.slice(0, 19).replace('T', ' ')}Z · {lastRun.mode} · {lastRun.stopped ? 'STOPPED' : 'done'}</span>
        </div>
        <button className="btn-ghost btn-xs ml-auto" onClick={() => downloadLog()}>⬇ Download complete run log</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
        <div>
          <div className="lbl mb-1">Dataset &amp; grid</div>
          {kv('Symbols', lastRun.dataset.symbols)}
          {kv('Range', `${lastRun.dataset.from} → ${lastRun.dataset.to}`)}
          {kv('Objective', lastRun.objective)}
          {kv('Combos', Number(lastRun.grid).toLocaleString())}
          {kv('Duration', `${lastRun.secs}s (${lastRun.rate}/s)`)}
          {kv('Refined', `${lastRun.refined} (${lastRun.passes} passes)`)}
          {kv('Errors', lastRun.errors)}
        </div>
        <div>
          <div className="lbl mb-1">Execution config</div>
          {kv('Direction', lastRun.exec.direction)}
          {kv('Entries', lastRun.exec.entry)}
          {kv('Fill', lastRun.exec.fill)}
          {kv('Session', lastRun.exec.session)}
          {kv('Exits', (lastRun.exec.exits || []).join('/'))}
          {kv('Day/carry', (lastRun.exec.carry || []).join('/'))}
          {kv('Regime', `${lastRun.exec.regime} @${Math.round((lastRun.exec.confGate ?? 0.6) * 100)}%`)}
          {kv('Qty × lot', `${lastRun.sizing.qty}×${lastRun.sizing.lot}`)}
          {kv('Cost', '₹' + lastRun.sizing.cost)}
        </div>
        <div>
          <div className="lbl mb-1">Best found {b?.refined ? '(refined 🔁)' : ''}</div>
          {b ? (<>
            {kv('Strategy', `[${b.sym}] ${b.tf}m ${b.ind}`)}
            {kv('Params', fmtParams(b.params))}
            {kv('SL / TP', `${b.sl}% / ${b.tp}% · ${b.exit}${b.carry ? '+carry' : ''}`)}
            {kv('Net P&L', <span className={b.m.netPnL >= 0 ? 'pos' : 'neg'}>{fmtMoney(b.m.netPnL)}</span>)}
            {kv('WR / Trades', `${b.m.winRate.toFixed(1)}% / ${b.m.totalTrades}`)}
            {kv('PF / MaxDD', `${b.m.profitFactor.toFixed(2)} / ${b.m.maxDD.toFixed(2)}%`)}
            {kv('Sharpe / Sortino', `${b.m.sharpe.toFixed(2)} / ${b.m.sortino.toFixed(2)}`)}
            {kv('OOS', b.oos.net == null ? '—' : `${fmtMoney(b.oos.net)} · ${b.oos.survived ? 'survived ✓' : 'failed ✗'}`)}
          </>) : <div className="text-zinc-500 text-[12px]">No rows (stopped early).</div>}
        </div>
      </div>
      {lastRun.bestPerSymbol?.length > 1 && (
        <div className="mt-2 text-[11px] num text-zinc-300">
          Best per symbol: {lastRun.bestPerSymbol.map((t: any) => `[${t.sym}] ${t.ind ? `${t.tf}m ${t.ind} WR${t.wr}% n${t.n} ${fmtMoney(t.pnl)}` : 'no rows'}`).join(' · ')}
        </div>
      )}
      {lastRun.top5?.length > 1 && (
        <div className="mt-2 text-[11px] num text-zinc-400">
          Top-5: {lastRun.top5.map((t: any, i: number) => `#${i + 1} ${t.tf}m ${t.ind} WR${t.wr}% n${t.n} ${fmtMoney(t.pnl)}`).join(' · ')}
        </div>
      )}
    </section>
  );
}
