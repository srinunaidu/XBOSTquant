import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { fmtMoney } from '../lib/format';
import { heatmap, monteCarloDD, streakStats, excursionStats } from '../lib/stress';
import { logLine } from '../lib/runner';

// Post-run stress lab for the SELECTED strategy: Monte-Carlo drawdown
// distribution, session heatmap, loss-streak/ruin odds, MAE/MFE, regime splits.
export default function StressPanel() {
  const detail = useStore(s => s.detail);
  const capital = useStore(s => s.capital);
  const [mcN, setMcN] = useState(1000);
  const [ran, setRan] = useState(0);

  const out = useMemo(() => {
    if (!detail || !ran) return null;
    const { bt } = detail;
    const mc = monteCarloDD(bt.trades, capital, mcN, 42);
    const st = streakStats(bt.trades);
    const heat = heatmap(bt.trades);
    const exc = excursionStats(bt.trades);
    return { mc, st, heat, exc };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, ran, mcN, capital]);

  if (!detail) return null;
  const run = () => {
    setRan(r => r + 1);
    setTimeout(() => {
      const s = useStore.getState();
      const d = s.detail;
      if (!d) return;
      const { bt } = d;
      const mc0 = monteCarloDD(bt.trades, s.capital, mcN, 42);
      const st0 = streakStats(bt.trades);
      const heat0 = heatmap(bt.trades);
      const exc0 = excursionStats(bt.trades);
      logLine(`stress [${d.cfg.symbol || ''} ${d.cfg.timeframe}m ${d.cfg.indicator}]: MC${mcN} p5-DD=${mc0 ? mc0.p5.toFixed(1) : '—'}% median=${mc0 ? mc0.p50.toFixed(1) : '—'}% worst=${mc0 ? mc0.worst.toFixed(1) : '—'}%`);
      logLine(`  streaks: maxLoss=${st0.maxLossStreak} P(4)=${(100 * st0.p4).toFixed(1)}% P(5)=${(100 * st0.p5).toFixed(1)}% P(6)=${(100 * st0.p6).toFixed(1)}%`);
      heat0.forEach(h => logLine(`  heat ${h.label}: n=${h.n} WR=${h.wr.toFixed(1)}% pnl=${h.pnl.toFixed(0)}`));
      if (exc0) logLine(`  excursion: avgMAE=${fmtMoney(exc0.avgMAE)} avgMFE=${fmtMoney(exc0.avgMFE)}`);
    }, 0);
  };

  return (
    <section className="card p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-display font-semibold text-[14px] tracking-tight">🧪 Stress Lab <span className="text-zinc-500 font-normal text-xs">· Monte Carlo · heatmap · streaks · MAE/MFE</span></div>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-400">
          <label>MC iters
            <select value={mcN} className="ml-1 num" onChange={e => setMcN(+e.target.value)}>
              {[200, 1000, 5000].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button className="btn-run !py-1 !px-3 !text-[12px]" onClick={run}>Run stress tests</button>
        </div>
      </div>
      {!out && <div className="empty-state">Run the lab to shuffle 1,000 trade sequences, slice session heat, and size losing streaks…</div>}
      {out && out.mc && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[12px]">
          <div className="rounded-lg border border-[#232329] p-2.5">
            <div className="lbl mb-1">MC max-DD dist ({out.mc.iters})</div>
            <div className="num">p5 <span className="neg">{out.mc.p5.toFixed(1)}%</span></div>
            <div className="num">median {out.mc.p50.toFixed(1)}%</div>
            <div className="num">worst {out.mc.worst.toFixed(1)}%</div>
          </div>
          <div className="rounded-lg border border-[#232329] p-2.5">
            <div className="lbl mb-1">Loss streaks</div>
            <div className="num">max {out.st.maxLossStreak} consecutive</div>
            <div className="num">P(4) {(100 * out.st.p4).toFixed(1)}% · P(5) {(100 * out.st.p5).toFixed(1)}% · P(6) {(100 * out.st.p6).toFixed(1)}%</div>
          </div>
          <div className="rounded-lg border border-[#232329] p-2.5">
            <div className="lbl mb-1">Excursion / trade</div>
            <div className="num">avg MAE {out.exc ? fmtMoney(out.exc.avgMAE) : '—'}</div>
            <div className="num">avg MFE {out.exc ? fmtMoney(out.exc.avgMFE) : '—'}</div>
          </div>
          <div className="rounded-lg border border-[#232329] p-2.5">
            <div className="lbl mb-1">Session heatmap</div>
            {out.heat.map(h => (
              <div key={h.label} className="num flex justify-between">
                <span className={h.pnl >= 0 ? 'pos' : 'neg'}>{h.label}</span>
                <span>{h.n}t · {fmtMoney(h.pnl)}</span>
              </div>
            ))}
            <div className="text-[10px] text-zinc-500 mt-1">Uncheck dead windows in ④ to drop them.</div>
          </div>
        </div>
      )}
    </section>
  );
}
