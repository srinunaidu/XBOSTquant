import React, { useState } from 'react';
import engine from '../lib/engine';
import { DEFAULT_RANGES, EXIT_LBL, IND_META, TFS } from '../lib/config';
import { useStore } from '../lib/store';
import { estimateCombos } from '../lib/runner';
import { applyDateFilter, loadFile, loadRepoCSV } from '../lib/data';
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

  const onUpload = async (f: File | undefined) => {
    if (!f) return;
    try {
      setLoadPct(10);
      await loadFile(f, setLoadPct);
      setLoadPct(null);
    } catch (e: any) {
      setLoadPct(null);
      set({ alert: `Could not parse "${f.name}": ${e?.message || e}. Expected header date,open,high,low,close,volume.` });
    }
  };

  const onRepo = async () => {
    try { await loadRepoCSV(); }
    catch (e: any) { set({ alert: `Bundled HDFCBANK.csv not found on this server — upload a 1-min CSV file instead. (${e?.message || e})` }); }
  };

  return (
    <div className="space-y-3">
      <Section n="① Market Data — 1-min OHLCV">
        <label className="block text-[11px] text-zinc-400 mb-1">Upload CSV <span className="text-zinc-600">(date,open,high,low,close,volume)</span></label>
        <input type="file" accept=".csv,.txt" className="w-full mb-2" onChange={e => onUpload(e.target.files?.[0])} />
        {loadPct !== null && <div className="prog mb-2"><div style={{ width: `${loadPct}%` }} /></div>}
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div><label className="lbl">Symbol</label>
            <input value={st.symbol} placeholder="e.g. NIFTY" className="w-full mt-1" onChange={e => set({ symbol: e.target.value.toUpperCase() })} /></div>
          <div><label className="lbl">Capital ₹</label>
            <input type="number" value={st.capital} className="w-full mt-1 num" onChange={e => set({ capital: +e.target.value || 100000 })} /></div>
        </div>
        <button className="btn-ghost btn-xs w-full" onClick={onRepo}>📁 Try bundled HDFCBANK.csv</button>
        <div className="text-[10px] text-zinc-500 mt-1.5">Symbol is set from your file name on upload. Real OHLCV only.</div>
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
        <ComboEst />
        <RunProgress />
      </Section>

      <ExecSection />
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
        <button className="text-[10px] text-green-400 hover:underline" onClick={() => {
          const cur = { ...useStore.getState().inds };
          for (const k of Object.keys(cur)) cur[k] = { ...cur[k], on: true };
          set({ inds: cur });
        }}>select all</button>
      </div>
      <div className="space-y-2">
        {IND_META.map((m, ix) => {
          if (m.cat) return <div key={ix} className="lbl !text-green-400 pt-1">{m.cat}</div>;
          const st = inds[m.n!];
          const schema = (engine as any).SCHEMA[m.n!] || [];
          return (
            <div key={m.n} className={`ind-card${st.on ? ' on' : ''}`}>
              <label className="flex items-center gap-2 text-[13px] font-semibold cursor-pointer">
                <input type="checkbox" checked={st.on} onChange={() => upd(m.n!, { on: !st.on })} /> {m.n}
                <span className="text-[10px] text-zinc-500 font-normal">{m.d}</span>
              </label>
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

