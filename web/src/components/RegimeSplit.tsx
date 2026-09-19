import { useMemo } from 'react';
import engine from '../lib/engine';
import { useStore } from '../lib/store';
import { fmtMoney } from '../lib/format';

const NAMES = ['Trend ↑', 'Trend ↓', 'Range HiVol', 'Range LoVol'];
const COLORS = ['#22ff88', '#fb4d6d', '#facc15', '#38bdf8'];

// Per-regime performance of the SELECTED strategy: trades / WR / net in each
// regime bucket. Answers "where does this edge actually live?".
export default function RegimeSplit() {
  const detail = useStore(s => s.detail);
  const regimeSource = useStore(s => s.regimeSource);

  const rows = useMemo(() => {
    if (!detail) return null;
    const { data: d, bt, cfg } = detail;
    const regs = regimeSource === 'ml'
      ? Int8Array.from(engine.trainRegimeML(d, 0.7, 15, 200).pred)
      : engine.regimeSeries(d, {});
    // attribute each trade to the regime of its ENTRY bar
    const agg = [0, 1, 2, 3].map(() => ({ n: 0, w: 0, pnl: 0 }));
    for (const t of bt.trades) {
      const r = regs[Math.min(regs.length - 1, Math.max(0, t.entryIdx))];
      agg[r].n++;
      if (t.pnl > 0) agg[r].w++;
      agg[r].pnl += t.pnl;
    }
    return agg.map((a, i) => ({
      name: NAMES[i], color: COLORS[i], n: a.n,
      wr: a.n ? (100 * a.w / a.n) : 0, pnl: a.pnl,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, regimeSource]);

  if (!rows) return null;
  return (
    <section className="card p-3">
      <div className="font-display font-semibold text-[14px] tracking-tight mb-2">
        🧭 Regime split <span className="text-zinc-500 font-normal text-xs">· {detail!.cfg.indicator} {detail!.cfg.timeframe}m · {regimeSource === 'ml' ? 'ML predicted' : 'rule'} regimes</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {rows.map(r => (
          <div key={r.name} className="rounded-lg border border-[#232329] p-2.5" style={{ borderLeft: `3px solid ${r.color}` }}>
            <div className="text-[11px] font-semibold" style={{ color: r.color }}>{r.name}</div>
            <div className="num text-lg font-bold mt-0.5">{r.n} <span className="text-[11px] text-zinc-500 font-normal">trades</span></div>
            <div className="num text-[12px] mt-0.5">WR {r.wr.toFixed(1)}% · <span className={r.pnl >= 0 ? 'pos' : 'neg'}>{fmtMoney(r.pnl)}</span></div>
          </div>
        ))}
      </div>
    </section>
  );
}
