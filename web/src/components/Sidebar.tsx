import React, { useState } from 'react';
import engine from '../lib/engine';
import { DEFAULT_RANGES, EXIT_LBL, IND_META, TFS, COST_PRESETS } from '../lib/config';
const TIERS_META: Record<string, string> = {};
for (const m of IND_META) if (m.n && m.tier) TIERS_META[m.n] = m.tier;
import { useStore } from '../lib/store';
import { estimateCombos } from '../lib/runner';
import { applyDateFilter, loadFile, selectATM } from '../lib/data';
import { downloadLog } from '../lib/export';
import { runValidation } from '../lib/validate';

function Section({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <section className="card p-3">
      <div className="flex items-center gap-2 mb-2"><span className="w-[7px] h-[7px] rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.8)]" /><div className="lbl">{n}</div></div>
      {children}
    </section>
  );
}

function Num({ id, label, value, onChange, step = 'any' }: any) {
  return (
    <div><label className="lbl">{label}</label>
      <input type="number" step={step} className="w-full mt-1 num" value={value}
        onChange={e => onChange(+e.target.value)} /></div>
  );
}

export default function Sidebar() {
  const st = useStore();
  const set = useStore(s => s.set);
  const [loadPct, setLoadPct] = useState<number | null>(null);

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setLoadPct(10);
    let ok = 0, fail: string | null = null;
    for (const f of Array.from(files)) {
      try { await loadFile(f); ok++; }
      catch (e: any) { fail = `"${f.name}": ${e?.message || e}`; }
    }
    setLoadPct(null);
    if (fail) set({ alert: `Could not parse ${fail}. Expected header date,open,high,low,close,volume (or SYMBOL,YYYYMMDD,HH:MM futures).` });
  };

  return (
    <div className="space-y-3">
      <Section n="① Market Data — 1-min OHLCV (multi-symbol)">
        <label className="block text-[11px] text-zinc-400 mb-1">Upload CSV files <span className="text-zinc-600">(multi-select allowed)</span></label>
        <input type="file" accept=".csv,.txt" multiple className="w-full mb-2" onChange={e => onUpload(e.target.files)} />
        <DatasetList />
        {loadPct !== null && <div className="prog mb-2"><div style={{ width: `${loadPct}%` }} /></div>}
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div><label className="lbl">Symbol</label>
            <input value={st.symbol} placeholder="e.g. NIFTY" className="w-full mt-1" onChange={e => set({ symbol: e.target.value.toUpperCase() })} /></div>
          <div><label className="lbl">Capital ₹</label>
            <input type="number" value={st.capital} className="w-full mt-1 num" onChange={e => set({ capital: +e.target.value || 100000 })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div><label className="lbl">Exchange (sessions)</label>
            <select value={st.exchange} className="w-full mt-1" onChange={e => {
              const ex = e.target.value;
              const sess = (engine as any).resolveSession(ex === 'auto' ? (engine as any).detectExchange(st.symbol) : ex, null, null);
              set({ exchange: ex, sessStart: sess.start, sessEnd: sess.end });
            }}>
              <option value="auto">Auto (from symbol)</option>
              <option value="NSE">NSE 09:15–15:30</option>
              <option value="MCX">MCX 09:00–23:30</option>
              <option value="NCDEX">NCDEX 09:00–21:00</option>
            </select></div>
          <div><label className="lbl">Effective</label>
            <div className="w-full mt-1 num text-[12px] text-emerald-300 py-1.5">{(engine as any).resolveSession(st.exchange === 'auto' ? (engine as any).detectExchange(st.symbol) : st.exchange, null, null).exchange}</div></div>
        </div>
        <div className="text-[10px] text-zinc-500 mt-1.5">Active symbol follows the file you upload; toggle symbols below to include them in runs.</div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div><label className="lbl">From</label>
            <input type="date" value={st.fromDate} className="w-full mt-1" onChange={e => { set({ fromDate: e.target.value }); applyDateFilter(); }} /></div>
          <div><label className="lbl">To</label>
            <input type="date" value={st.toDate} className="w-full mt-1" onChange={e => { set({ toDate: e.target.value }); applyDateFilter(); }} /></div>
        </div>
        <div className="text-[11px] text-zinc-500 mt-2 num">{st.dataInfo}</div>
      </Section>

      <Section n="② Timeframes — multi-check resample">
        <div className="flex flex-wrap gap-1.5">
          {TFS.map(tf => (
            <button key={tf} className={`tf-pill num${st.timeframes.includes(tf) ? ' on' : ''}`}
              aria-pressed={st.timeframes.includes(tf)}
              onClick={() => set({ timeframes: st.timeframes.includes(tf) ? st.timeframes.filter(t => t !== tf) : [...st.timeframes, tf].sort((a, b) => a - b) })}>
              {tf}m</button>
          ))}
        </div>
        <div className="text-[10px] text-zinc-500 mt-1.5">1-min bars resampled on the fly (O/H/L/C/V aware).</div>
      </Section>

      <Section n="③ Primary objective">
        <select value={st.objective} className="w-full" onChange={e => set({ objective: e.target.value })}>
          <option value="sharpe">🏆 Best Risk-Adjusted — Sharpe Ratio</option>
          <option value="sortino">🛡 Best Risk-Adjusted — Sortino Ratio</option>
          <option value="winrate">🎯 Highest Win Rate (WR %)</option>
          <option value="trades">⚡ Maximum Trade Frequency (# Trades)</option>
          <option value="drawdown">🧊 Lowest Max Drawdown (Min DD %)</option>
        </select>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Num id="topN" label="Top-N board" value={st.topN} onChange={(v: number) => set({ topN: v || 500 })} />
          <Num id="cap" label="Max combos cap" value={st.cap} onChange={(v: number) => set({ cap: v || 60000 })} />
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Num id="minTr" label="Hide rows < N trades" value={st.minTradesBoard} onChange={(v: number) => set({ minTradesBoard: Math.max(0, v || 0) })} />
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div><label className="lbl">Grid sampler</label>
            <select value={st.gridMode} className="w-full mt-1" onChange={e => set({ gridMode: e.target.value as any })}>
              <option value="cartesian">Cartesian (exhaustive)</option>
              <option value="halton">Halton (low-discrepancy) ★</option>
            </select></div>
          <Num id="haltonN" label="Halton points" value={st.haltonN} onChange={(v: number) => set({ haltonN: v || 256 })} />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-emerald-300 mt-2 cursor-pointer">
          <input type="checkbox" checked={st.bayesRefine} onChange={e => set({ bayesRefine: e.target.checked })} />
          Bayesian EI refine pass (GP over top-40, +24 proposals)
        </label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Num id="purge" label="WF purge bars" value={st.purgeBars} onChange={(v: number) => set({ purgeBars: Math.max(0, v || 0) })} />
          <Num id="embargo" label="WF embargo bars" value={st.embargoBars} onChange={(v: number) => set({ embargoBars: Math.max(0, v || 0) })} />
        </div>
        <div className="text-[10px] text-zinc-500 mt-1">Halton covers the same space as Cartesian with N quasi-random points (deterministic). Purge/embargo gaps stop IS structure leaking into OOS.</div>
        <div className="flex items-center gap-2 mt-2">
          <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={st.wfOn} onChange={() => set({ wfOn: !st.wfOn })} />
            Walk-forward: verify top-200 on untouched tail</label>
          {st.wfOn && (
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">IS
              <input type="number" value={st.wfSplit} min={50} max={90} className="w-14 num"
                onChange={e => set({ wfSplit: Math.min(90, Math.max(50, +e.target.value || 70)) })} />%</label>
          )}
        </div>
        <ComboEst />
        <RunProgress />
      </Section>

      <ExecSection />
      <RegimeSection />
      <IndSection />
      <Section n="⑥ Fill model (anti-lookahead)">
        <label className="lbl">Signal fill timing</label>
        <select value={st.fill} className="w-full mt-1" onChange={e => set({ fill: e.target.value })}>
          <option value="close">Signal-bar CLOSE (causal, standard)</option>
          <option value="next">NEXT bar OPEN (stricter, no touch)</option>
        </select>
        <div className="text-[10px] text-zinc-500 mt-1">Stops fill intrabar at stop levels in both modes.</div>
      </Section>

      <section className="card p-3" style={{ borderColor: '#7c2d12' }}>
        <div className="lbl mb-2">🛠 Developer panel — live-data audit</div>
        <button className="btn-run w-full text-[13px]" onClick={() => runValidation()}>🔬 Debug &amp; Validate on live data</button>
        <button className="btn-ghost btn-xs w-full mt-2" onClick={() => downloadLog()}>⬇ Download session log (.txt)</button>
        <div className="text-[10px] text-zinc-500 mt-1">Audits the loaded file + engine identities. Zero synthetic data.</div>
        <ValidationOut />
      </section>
    </div>
  );
}

function DatasetList() {
  const datasets = useStore(s => s.datasets);
  const set = useStore(s => s.set);
  const names = Object.keys(datasets);
  if (!names.length) return null;
  const toggle = (k: string) => {
    const ds = { ...datasets, [k]: { ...datasets[k], enabled: datasets[k].enabled === false } };
    set({ datasets: ds });
  };
  const remove = (k: string) => {
    const ds = { ...datasets };
    delete ds[k];
    set({ datasets: ds });
    if (useStore.getState().symbol === k) {
      const rest = Object.keys(ds);
      set({ symbol: rest[0] || '' });
    }
  };
  return (
    <div className="space-y-1 mb-2">
      {names.map(k => {
        const n = datasets[k].raw.t.length;
        const on = datasets[k].enabled !== false;
        return (
          <div key={k} className="flex items-center gap-2 text-[12px] bg-[#15151b] border border-[#2e2e36] rounded-md px-2 py-1">
            <input type="checkbox" checked={on} onChange={() => toggle(k)} title="Include in runs" />
            <span className="num font-semibold">{k}</span>
            <span className="text-zinc-500 num">{(n / 1000).toFixed(0)}k bars</span>
            <button className="ml-auto text-zinc-500 hover:text-red-400" onClick={() => remove(k)} title="Remove">✕</button>
          </div>
        );
      })}
      <AtmSelect />
    </div>
  );
}

function AtmSelect() {
  const [msg, setMsg] = React.useState<string | null>(null);
  const [legs, setLegs] = React.useState(1);
  return (
    <div className="flex items-center gap-1.5 pt-1">
      <button className="btn-ghost btn-xs flex-1" title="Enable only ATM±N contracts vs the underlying dataset"
        onClick={() => {
          const r = selectATM(legs);
          setMsg(r.enabled.length ? `ATM±${legs}: ${r.enabled.length} on` : `ATM select: ${r.reason}`);
        }}>
        🎯 ATM ± select
      </button>
      <input type="number" value={legs} min={0} max={5} className="w-12 num"
        onChange={e => setLegs(Math.min(5, Math.max(0, +e.target.value || 1)))} title="legs each side" />
      {msg && <span className="text-[10px] text-zinc-500">{msg}</span>}
    </div>
  );
}

function ComboEst() {
  const inds = useStore(s => s.inds);
  const timeframes = useStore(s => s.timeframes);
  const exits = useStore(s => s.exits);
  const sessMode = useStore(s => s.sessMode);
  const optRisk = useStore(s => s.optRisk);
  const slMin = useStore(s => s.slMin); const slMax = useStore(s => s.slMax); const slStep = useStore(s => s.slStep);
  const tpMin = useStore(s => s.tpMin); const tpMax = useStore(s => s.tpMax); const tpStep = useStore(s => s.tpStep);
  const cap = useStore(s => s.cap);
  const n = React.useMemo(() => {
    try { return estimateCombos(); } catch { return 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inds, timeframes, exits, sessMode, optRisk, slMin, slMax, slStep, tpMin, tpMax, tpStep]);
  return <div className={`text-[11px] mt-2 num ${n > cap ? 'text-red-400' : 'text-amber-300'}`}>Combos: {n}</div>;
}

function RunProgress() {
  const run = useStore(s => s.run);
  const pct = typeof run.done === 'number' && typeof run.total === 'number' && run.total ? Math.min(100, (run.done / run.total) * 100) : 0;
  if (!run.running && !run.summary.startsWith('done') && !run.summary.startsWith('■')) return null;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <div className="prog flex-1"><div style={{ width: `${pct}%` }} /></div>
        {run.running && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-500 text-zinc-950 animate-pulse whitespace-nowrap">● LIVE</span>}
      </div>
      <div className="text-[11px] text-zinc-400 num mt-1">{run.summary}</div>
      {run.current && <div className="text-[11px] text-green-300 num mt-0.5">{run.current}</div>}
    </div>
  );
}

function ExecSection() {
  const st = useStore();
  const set = useStore(s => s.set);
  return (
    <section className="card p-3">
      <div className="flex items-center gap-2 mb-2"><span className="w-[7px] h-[7px] rounded-full bg-emerald-400" /><div className="lbl">④ Trade execution &amp; intraday rules</div></div>
      <label className="lbl">Direction</label>
      <div className="flex gap-3 text-xs my-1.5">
        {['Long', 'Short', 'Both'].map(d => (
          <label key={d} className="flex items-center gap-1"><input type="radio" checked={st.direction === d} onChange={() => set({ direction: d })} /> {d}</label>
        ))}
      </div>
      <button className="btn-ghost btn-xs w-full mb-1" title="Options desk preset: buy-only (Long), trigger entries, next-bar fill"
        onClick={() => set({ direction: 'Long', entry: 'trigger', fill: 'next' })}>
        ⚡ Options buy-only preset (Long · trigger · next-bar)
      </button>
      <label className="lbl">Entries</label>
      <select value={st.entry} className="w-full mt-1 mb-1" onChange={e => set({ entry: e.target.value })}>
        <option value="trigger">Signal trigger only (no auto re-entry)</option>
        <option value="always">Always in market (flip re-entry)</option>
      </select>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="lbl">Session start</label><input type="time" value={st.sessStart} className="w-full mt-1 num" onChange={e => set({ sessStart: e.target.value })} /></div>
        <div><label className="lbl">Session end</label><input type="time" value={st.sessEnd} className="w-full mt-1 num" onChange={e => set({ sessEnd: e.target.value })} /></div>
        <div><label className="lbl">Stop-loss % <span className="text-zinc-600">(fallback)</span></label><input type="number" step="0.1" value={st.slFix} disabled={st.optRisk} className="w-full mt-1 num" style={{ opacity: st.optRisk ? .35 : 1 }} onChange={e => set({ slFix: +e.target.value || 0 })} /></div>
        <div><label className="lbl">Target % <span className="text-zinc-600">(fallback)</span></label><input type="number" step="0.1" value={st.tpFix} disabled={st.optRisk} className="w-full mt-1 num" style={{ opacity: st.optRisk ? .35 : 1 }} onChange={e => set({ tpFix: +e.target.value || 0 })} /></div>
        <div><label className="lbl">Trailing %</label><input type="number" step="0.1" value={st.trail} className="w-full mt-1 num" onChange={e => set({ trail: +e.target.value || 0 })} /></div>
        <div><label className="lbl">Cost / trade ₹</label><input type="number" step="1" value={st.cost} className="w-full mt-1 num" onChange={e => set({ cost: +e.target.value || 0 })} /></div>
        <div><label className="lbl">Qty (× lot)</label><input type="number" value={st.qty} className="w-full mt-1 num" onChange={e => set({ qty: +e.target.value || 1 })} /></div>
        <div><label className="lbl">Lot size</label><input type="number" value={st.lot} className="w-full mt-1 num" onChange={e => set({ lot: +e.target.value || 1 })} /></div>
      </div>
      <div className="mt-1.5">
        <div className="lbl mb-1">Cost preset (zero-cost runs can never pass the paper gate)</div>
        <div className="grid grid-cols-2 gap-1">
          {Object.entries(COST_PRESETS).map(([k, p]) => (
            <button key={k} className="btn-ghost btn-xs" title={p.label}
              onClick={() => set({ cost: p.cost, lot: p.lot })}>
              {k.replace('_', ' ')} ₹{p.cost}×{p.lot}</button>
          ))}
        </div>
        {!(st.cost > 0) && (
          <div className="text-[11px] text-red-400 mt-1">⚠ cost = 0 — paper gate will BLOCK every row. Pick a preset.</div>
        )}
      </div>
      <div className="mt-1.5">
        <div className="lbl mb-1">Cost mode</div>
        <div className="flex gap-3 text-xs">
          {[['realistic', 'Realistic (costs applied)'], ['signal', 'Signal-only (cost=0) ⚠']].map(([v, l]) => (
            <label key={v} className="flex items-center gap-1"><input type="radio" checked={st.costMode === v} onChange={() => set({ costMode: v })} /> {l}</label>
          ))}
        </div>
        <div className="text-[10px] text-zinc-500 mt-1">Signal-only is for research — paper gate warns and never fully passes on costs.</div>
      </div>
      <div className="mt-1.5 rounded-lg border border-purple-900 bg-purple-950/20 p-2">
        <div className="lbl mb-1.5">Options structure filters</div>
        <div className="grid grid-cols-2 gap-1.5">
          <Num label="Premium floor ₹" value={st.premiumFloor} onChange={(v: number) => set({ premiumFloor: Math.max(0, v || 0) })} />
          <Num label="Max IV-rank (0-1)" value={st.ivMaxRank ?? 1} onChange={(v: number) => set({ ivMaxRank: v >= 1 ? null : Math.min(0.99, Math.max(0.05, v || 1)) })} />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-300 mt-1.5 cursor-pointer">
          <input type="checkbox" checked={st.excludeExpiry} onChange={() => set({ excludeExpiry: !st.excludeExpiry })} />
          Exclude expiry-day bars (gamma-risk zone)
        </label>
        <div className="text-[10px] text-zinc-500 mt-1">Floor skips sub-₹ entries · IV-rank ≤ max only (needs long file) · expiry needs an expiry column.</div>
      </div>
      <div className="mt-2 rounded-lg border border-amber-900 bg-amber-950/20 p-2">
        <div className="lbl mb-1.5">Exit logic — searched dimensions</div>
        <div className="flex flex-col gap-1 text-[12px]">
          {[['fixed', 'Fixed SL / TP'], ['breakeven', 'Moving SL — breakeven + trail'], ['atr', 'ATR Chandelier trailing stop'], ['ck', 'CK structural stop (presets)']].map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={st.exits.includes(v)} onChange={() => set({ exits: st.exits.includes(v) ? st.exits.filter(x => x !== v) : [...st.exits, v] })} /> {l}</label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          <Num label="BE trigger %" value={st.beTrigger} onChange={(v: number) => set({ beTrigger: v })} />
          <Num label="BE lock %" value={st.beLock} onChange={(v: number) => set({ beLock: v })} />
          <Num label="ATR period" value={st.atrP} onChange={(v: number) => set({ atrP: v || 14 })} />
          <Num label="ATR mult" value={st.atrM} onChange={(v: number) => set({ atrM: v })} />
          <Num label="CK period" value={st.ckP} onChange={(v: number) => set({ ckP: v || 10 })} />
          <Num label="CK mult" value={st.ckM} onChange={(v: number) => set({ ckM: v })} />
        </div>
        <div className="lbl mt-2 mb-1">Session handling — compare intraday vs carry</div>
        <div className="flex gap-3 text-xs">
          {[['intraday', 'Intraday (flat 15:15)'], ['carry', 'Carry overnight'], ['both', 'Both ⚖']].map(([v, l]) => (
            <label key={v} className="flex items-center gap-1"><input type="radio" checked={st.sessMode === v} onChange={() => set({ sessMode: v })} /> {l}</label>
          ))}
        </div>
      </div>
      <div className="mt-2 rounded-lg border border-green-900 bg-green-950/30 p-2">
        <label className="flex items-center gap-2 text-[12px] font-semibold text-green-300 cursor-pointer">
          <input type="checkbox" checked={st.optRisk} onChange={() => set({ optRisk: !st.optRisk })} /> 🎯 Optimize Stop / Target in grid search</label>
        <div className={`text-[10px] mt-1 ${st.optRisk ? 'text-green-300' : 'text-amber-300'}`}>
          {st.optRisk ? '● GRID ACTIVE — every SL × TP below is backtested per combo; winners appear in the board\u2019s SL % / TP % columns.' : '○ GRID OFF — the single fallback SL/TP values above apply to every combo.'}
        </div>
        <div className="grid grid-cols-3 gap-1.5 mt-1.5">
          <Num label="SL min %" value={st.slMin} onChange={(v: number) => set({ slMin: v })} />
          <Num label="SL max %" value={st.slMax} onChange={(v: number) => set({ slMax: v })} />
          <Num label="SL step" value={st.slStep} onChange={(v: number) => set({ slStep: v })} />
          <Num label="TP min %" value={st.tpMin} onChange={(v: number) => set({ tpMin: v })} />
          <Num label="TP max %" value={st.tpMax} onChange={(v: number) => set({ tpMax: v })} />
          <Num label="TP step" value={st.tpStep} onChange={(v: number) => set({ tpStep: v })} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-zinc-400 mt-2">
        <input type="checkbox" checked={st.useSession} onChange={() => set({ useSession: !st.useSession })} />
        Enforce intraday session filter (flat outside hours, no overnight)</label>
      <div className="mt-1.5">
        <div className="lbl mb-1">Trade windows (uncheck to drop a chop zone)</div>
        <div className="grid grid-cols-2 gap-1">
          {[['b1', '09:15–10:00'], ['b2', '10:00–12:00'], ['b3', '12:00–14:00'], ['b4', '14:00–15:30']].map(([v, l]) => (
            <label key={v} className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
              <input type="checkbox" checked={st.tradeWindows.includes(v)}
                onChange={() => set({ tradeWindows: st.tradeWindows.includes(v) ? st.tradeWindows.filter(x => x !== v) : [...st.tradeWindows, v] })} />
              {l}</label>
          ))}
        </div>
      </div>
    </section>
  );
}

function RegimeSection() {
  const regimeOn = useStore(s => s.regimeOn);
  const regimeSource = useStore(s => s.regimeSource);
  const granularity = useStore(s => s.granularity);
  const confGate = useStore(s => s.confGate);
  const set = useStore(s => s.set);
  return (
    <section className="card p-3">
      <div className="flex items-center gap-2 mb-2"><span className="w-[7px] h-[7px] rounded-full bg-emerald-400" /><div className="lbl">⑦ Market regime router</div></div>
      <label className="flex items-center gap-2 text-[12px] font-semibold text-green-300 cursor-pointer">
        <input type="checkbox" checked={regimeOn} onChange={() => set({ regimeOn: !regimeOn })} />
        Route entries by regime (trend / range / high-vol)
      </label>
      <label className="flex items-center gap-2 text-[11px] text-emerald-300 mt-1.5 cursor-pointer">
        <input type="checkbox" checked={useStore(s => s.routerV2)} onChange={e => set({ routerV2: e.target.checked })} />
        Router v2 — persistence + hysteresis (anti flip-flop) ★
      </label>
      {useStore(s => s.routerV2) && (
        <div className="grid grid-cols-2 gap-2 mt-1.5">
          <Num label="Persist bars" value={useStore(s => s.routerPersist)} onChange={(v: number) => set({ routerPersist: Math.max(1, v || 5) })} />
          <Num label="Hysteresis +" value={useStore(s => s.routerHyst)} onChange={(v: number) => set({ routerHyst: Math.max(0, v || 0) })} />
        </div>
      )}
      <div className="flex gap-3 text-xs mt-1.5">
        <label className="flex items-center gap-1"><input type="radio" checked={granularity === 'day'} onChange={() => set({ granularity: 'day' })} /> Day labels ★</label>
        <label className="flex items-center gap-1"><input type="radio" checked={granularity === 'bar'} onChange={() => set({ granularity: 'bar' })} /> Per-bar (adv)</label>
      </div>
      <div className="flex gap-3 text-xs mt-1.5">
        <label className="flex items-center gap-1"><input type="radio" checked={regimeSource === 'rules'} onChange={() => set({ regimeSource: 'rules' })} /> Rule regimes</label>
        <label className="flex items-center gap-1"><input type="radio" checked={regimeSource === 'ml'} onChange={() => set({ regimeSource: 'ml' })} /> ML predicted ★</label>
        <label className="flex items-center gap-1 text-zinc-400">conf ≥
          <input type="number" value={confGate} min={0} max={100} className="w-14 num"
            onChange={e => set({ confGate: Math.min(100, Math.max(0, +e.target.value || 60)) })} />%</label>
      </div>
      <div className="text-[10px] text-zinc-500 mt-1">Below 60% confidence a day runs unrouted — counted in the log, never silent.</div>
      <details className="mt-1.5 text-[11px] text-zinc-400">
        <summary className="cursor-pointer text-zinc-500">routing table (indicator → regimes)</summary>
        <div className="num mt-1">T+ trend-up · T− trend-down · RH range-high-vol · RL range-low-vol</div>
        <div className="num mt-1">trend legs → T+/T− · mean-reversion → RH/RL · breakout → T/RH · gates → all</div>
      </details>
    </section>
  );
}

function IndSection() {
  const inds = useStore(s => s.inds);
  const set = useStore(s => s.set);
  const upd = (n: string, patch: Partial<(typeof inds)[string]>) =>
    set({ inds: { ...useStore.getState().inds, [n]: { ...useStore.getState().inds[n], ...patch } } });
  return (
    <section className="card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2"><span className="w-[7px] h-[7px] rounded-full bg-emerald-400" /><div className="lbl">⑤ Indicators A–Z + param ranges</div></div>
        <div className="flex gap-1 items-center">
          {[['A', 'Tier A only'], ['B', 'Tier B only'], ['C', 'Tier C only']].map(([t, l]) => (
            <button key={t} title={l} className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:border-green-400"
              onClick={() => {
                const cur = { ...useStore.getState().inds };
                for (const k of Object.keys(cur)) cur[k] = { ...cur[k], on: (TIERS_META[k] || 'B') === t };
                set({ inds: cur });
              }}>{t}</button>
          ))}
          <button className="text-[10px] text-green-400 hover:underline px-1" onClick={() => {
            const cur = { ...useStore.getState().inds };
            for (const k of Object.keys(cur)) cur[k] = { ...cur[k], on: true };
            set({ inds: cur });
          }}>all</button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-[11px] text-emerald-300 mb-2 cursor-pointer">
        <input type="checkbox" checked={useStore(s => s.adaptive)} onChange={e => set({ adaptive: e.target.checked })} />
        Adaptive — auto-expand to B/C if best is weak (Sharpe &lt;1.2)
      </label>
      <div className="space-y-2">
        {IND_META.map((m, ix) => {
          if (m.cat) return <div key={ix} className="lbl !text-green-400 pt-1">{m.cat}</div>;
          const st = inds[m.n!];
          const schema = (engine as any).SCHEMA[m.n!] || [];
          return (
            <div key={m.n} className={`ind-card${st.on ? ' on' : ''}`}>
              <label className="flex items-center gap-2 text-[13px] font-semibold cursor-pointer"
                onClick={e => { e.preventDefault(); upd(m.n!, { on: !st.on }); }}>
                <input type="checkbox" checked={st.on} readOnly />
                <span className="text-[10px] font-bold px-1 rounded" style={{
                  color: m.tier === 'A' ? '#22ff88' : m.tier === 'B' ? '#fbbf24' : '#8b8b96',
                  border: '1px solid currentColor', opacity: 0.9 }}> {m.tier} </span>
                {m.n} <span className="text-[10px] text-zinc-500 font-normal">{m.d}</span>
                <span className="ml-auto text-zinc-600 text-[10px]">{st.on ? '▾' : '▸'}</span>
              </label>
              {st.on && (<>
              {schema.length ? (
                <div className="param-grid">
                  {schema.map((p: any) => (
                    <div key={p.key} style={{ display: 'contents' }}>
                      <div><label>{p.key} min</label><input type="number" step="any" className="w-full num"
                        value={st.ranges[p.key]?.min ?? p.def}
                        onChange={e => upd(m.n!, { ranges: { ...st.ranges, [p.key]: { ...st.ranges[p.key], min: +e.target.value } } })} /></div>
                      <div><label>max</label><input type="number" step="any" className="w-full num"
                        value={st.ranges[p.key]?.max ?? p.def}
                        onChange={e => upd(m.n!, { ranges: { ...st.ranges, [p.key]: { ...st.ranges[p.key], max: +e.target.value } } })} /></div>
                      <div><label>step</label><input type="number" step="any" className="w-full num"
                        value={st.ranges[p.key]?.step ?? 1}
                        onChange={e => upd(m.n!, { ranges: { ...st.ranges, [p.key]: { ...st.ranges[p.key], step: +e.target.value } } })} /></div>
                    </div>
                  ))}
                </div>
              ) : <div className="text-[10px] text-zinc-500 mt-1">No parameters — single config per timeframe.</div>}
              </>)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ValidationOut() {
  const lines = useStore(s => s.validation);
  const ok = useStore(s => s.valOk);
  if (!lines.length) return <pre className="text-[10px] num text-zinc-500 mt-2">Not run yet.</pre>;
  return (
    <pre className="text-[10px] num text-zinc-300 bg-zinc-950 border rounded-md p-2 mt-2 whitespace-pre-wrap max-h-64 overflow-auto"
      style={{ borderColor: ok ? '#22ff88' : '#ff3b5c' }}>
      {lines.join('\n')}
    </pre>
  );
}

