import { useEffect, useMemo, useState } from 'react';

// OPTION DISCOVERY tab — independent research console.
// Reads ONLY the exported tab_bundle.json produced by xbost_option_discovery.
// No imports from the futures/options strategy engine. No futures signals.

type Bundle = {
  run_id: string; dataset_hash: string; configuration_hash: string;
  settings: Record<string, any>;
  status_bar: Record<string, string>;
  data_health: Record<string, any>;
  chain_metadata: Record<string, any>;
  modules: Record<string, string>;
  modules_unavailable: Record<string, string>;
  counts: Record<string, number>;
  filter_log: { filter: string; input_count: number; passed_count: number; rejected_count: number; rejection_reason: string }[];
  candidates: Record<string, any>[];
  leadlag: Record<string, any>[];
  formulas: Record<string, string>;
  sharpe_defs: Record<string, any>;
};

const TABLE_COLS: { key: string; label: string; num: boolean }[] = [
  { key: 'candidate', label: 'Candidate', num: false },
  { key: 'discovery_family', label: 'Family', num: false },
  { key: 'contract', label: 'Contract', num: false },
  { key: 'events', label: 'Events', num: true },
  { key: 'clusters', label: 'Clusters', num: true },
  { key: 'FWD_expectancy', label: 'FWD Exp', num: true },
  { key: 'FWD_WR', label: 'FWD WR', num: true },
  { key: 'FWD_OOS_expectancy', label: 'OOS Exp', num: true },
  { key: 'IS_TRADE_SHARPE', label: 'TRADE Sharpe', num: true },
  { key: 'robustness_score', label: 'Robust 0-10', num: true },
  { key: 'top5', label: 'Top5 conc', num: true },
  { key: 'perm_p_adj', label: 'BH p', num: true },
  { key: 'final_status', label: 'Status', num: false },
];

function fmt(v: any): string {
  if (v === null || v === undefined || v === 'NA') return 'NA';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  const s = String(v);
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}

function Spark({ data, stroke }: { data: number[]; stroke: string }) {
  if (!data || data.length < 2) return <span className="text-zinc-600">NA</span>;
  const mn = Math.min(...data), mx = Math.max(...data), rg = mx - mn || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 120},${28 - ((v - mn) / rg) * 26}`).join(' ');
  return <svg width="120" height="30" className="inline-block"><polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" /></svg>;
}

export default function Discovery() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fam, setFam] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [minEv, setMinEv] = useState(0);
  const [q, setQ] = useState('');
  const [obj, setObj] = useState('composite');
  const [sortK, setSortK] = useState('rank_composite');
  const [sortD, setSortD] = useState<1 | -1>(-1);
  const [sel, setSel] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    fetch('./discovery-bundle.json').then(r => {
      if (!r.ok) throw new Error('no shipped bundle');
      return r.json();
    }).then(setBundle).catch(() => setErr('No discovery bundle shipped — upload a tab_bundle.json exported by the research engine.'));
  }, []);

  const onFile = async (files: FileList | null) => {
    if (!files || !files.length) return;
    try { setBundle(JSON.parse(await files[0].text())); setErr(null); }
    catch (e: any) { setErr(`Could not parse bundle: ${e?.message || e}`); }
  };

  const fams = useMemo(() => ['ALL', ...Array.from(new Set((bundle?.candidates || []).map(c => String(c.discovery_family))))], [bundle]);
  const statuses = useMemo(() => ['ALL', ...Array.from(new Set((bundle?.candidates || []).map(c => String(c.final_status))))], [bundle]);

  const rows = useMemo(() => {
    let r = (bundle?.candidates || []).slice();
    if (fam !== 'ALL') r = r.filter(c => String(c.discovery_family) === fam);
    if (status !== 'ALL') r = r.filter(c => String(c.final_status) === status);
    if (minEv > 0) r = r.filter(c => Number(c.events) >= minEv);
    if (q) r = r.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase()));
    const k = obj === 'composite' ? 'rank_composite' : `rank_${obj}`;
    const key = TABLE_COLS.some(c => c.key === sortK) ? sortK : k;
    r.sort((x, y) => {
      const a = x[key], b = y[key];
      const an = typeof a === 'number' ? a : NaN, bn = typeof b === 'number' ? b : NaN;
      if (!isNaN(an) && !isNaN(bn)) return (an - bn) * sortD;
      return String(a ?? '').localeCompare(String(b ?? '')) * sortD;
    });
    return r;
  }, [bundle, fam, status, minEv, q, obj, sortK, sortD]);

  if (!bundle) {
    return (
      <div className="min-h-screen bg-[#0d0d12] text-zinc-300 p-8 max-w-3xl mx-auto">
        <h1 className="font-display text-xl text-white">OPTION DISCOVERY</h1>
        <p className="text-sm text-zinc-500 mt-2">Independent option-native research console. No futures signals are used anywhere in this tab.</p>
        <label className="block mt-6 cursor-pointer rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center">
          <input type="file" accept=".json" className="hidden" onChange={e => onFile(e.target.files)} />
          <div className="text-sm">📂 Upload <span className="num">tab_bundle.json</span> (exported by xbost_option_discovery)</div>
        </label>
        {err && <div className="text-[12px] text-amber-300 mt-3">{err}</div>}
        <a href="#/" className="text-[12px] text-emerald-400 mt-4 inline-block">← Back</a>
      </div>
    );
  }

  const sb = bundle.status_bar || {};
  const mods = bundle.modules || {};
  const pill = (v: string) => v === 'PASS' || v === 'AVAILABLE' || v === 'TRUE'
    ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40'
    : v === 'FALSE' || v === 'FAIL'
      ? 'text-red-300 border-red-900 bg-red-950/30'
      : 'text-zinc-400 border-zinc-700 bg-zinc-900/60';

  return (
    <div className="min-h-screen bg-[#0d0d12] text-zinc-300">
      <header className="border-b border-[#232329] px-4 py-3 flex items-center gap-3">
        <a href="#/" className="text-emerald-400 text-sm">←</a>
        <h1 className="font-display font-bold text-white tracking-tight">OPTION DISCOVERY</h1>
        <span className="text-[10px] text-zinc-500 num">run {bundle.run_id} · data {bundle.dataset_hash} · cfg {bundle.configuration_hash}</span>
      </header>

      {/* status bar */}
      <section className="px-4 pt-3 flex flex-wrap gap-1.5">
        {Object.entries(sb).map(([k, v]) => (
          <span key={k} title={k} className={`text-[10px] num px-2 py-0.5 rounded-full border ${pill(String(v))}`}>{k} · {String(v)}</span>
        ))}
      </section>

      <main className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-4">
        {/* chain + health */}
        <section className="card p-4">
          <div className="lbl mb-2">DATA HEALTH · CHAIN STRUCTURE (dynamic)</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[12px] num">
            <div>contracts <b className="text-white">{bundle.chain_metadata?.n_contracts}</b></div>
            <div>strikes <b className="text-white">{bundle.chain_metadata?.n_strikes}</b></div>
            <div>types <b className="text-white">{JSON.stringify(bundle.chain_metadata?.option_types)}</b></div>
            <div>expiries <b className="text-white">{JSON.stringify(bundle.chain_metadata?.expiries)}</b></div>
            <div>snapshots <b className="text-white">{bundle.chain_metadata?.synchronized_snapshots}</b></div>
            <div>completeness <b className="text-white">{bundle.chain_metadata?.completeness}</b></div>
            <div>bid/ask <b className="text-white">{bundle.chain_metadata?.has_bidask ? 'yes' : 'no (RESEARCH_PRICE_MODEL)'}</b></div>
            <div>health <b className="text-white">{bundle.data_health?.status}</b></div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(mods).map(([k, v]) => (
              <span key={k} className={`text-[10px] num px-2 py-0.5 rounded-full border ${pill(String(v))}`}>{k} · {String(v)}</span>
            ))}
          </div>
          {Object.keys(bundle.modules_unavailable || {}).length > 0 && (
            <div className="text-[11px] text-zinc-500 mt-2">NOT_APPLICABLE: {Object.entries(bundle.modules_unavailable).map(([k, v]) => `${k} (${v})`).join(' · ')}</div>
          )}
        </section>

        {/* settings */}
        <details className="card p-4">
          <summary className="lbl cursor-pointer">RESEARCH SETTINGS (configuration-driven)</summary>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 mt-2 text-[11px] num">
            {Object.entries(bundle.settings || {}).map(([k, v]) => (
              <div key={k} className="bg-[#111] border border-zinc-800 rounded px-2 py-1"><span className="text-zinc-500">{k}</span> <span className="text-zinc-200">{fmt(v)}</span></div>
            ))}
          </div>
        </details>

        {/* filters */}
        <section className="card p-4">
          <div className="lbl mb-2">FILTERABLE DISCOVERY BOARD</div>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <select value={fam} onChange={e => setFam(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1">
              {fams.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1">
              {statuses.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <select value={obj} onChange={e => setObj(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1" title="Ranking objective">
              {['composite', 'sharpe', 'expectancy', 'pf', 'oos', 'robustness'].map(o => <option key={o} value={o}>rank: {o}</option>)}
            </select>
            <input type="number" value={minEv} onChange={e => setMinEv(Number(e.target.value))} placeholder="min events" className="bg-[#111] border border-zinc-700 rounded px-2 py-1 w-28 num" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="search…" className="bg-[#111] border border-zinc-700 rounded px-2 py-1 flex-1 min-w-[140px]" />
            <span className="text-zinc-500 num self-center">{rows.length} rows</span>
          </div>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-[11px] num">
              <thead><tr className="text-zinc-500 text-left border-b border-zinc-800">
                {TABLE_COLS.map(c => (
                  <th key={c.key} className="px-2 py-1 cursor-pointer hover:text-emerald-300 whitespace-nowrap"
                    onClick={() => { if (sortK === c.key) setSortD(d => d === 1 ? -1 : 1); else { setSortK(c.key); setSortD(-1); } }}>
                    {c.label}{sortK === c.key ? (sortD === -1 ? ' ▼' : ' ▲') : ''}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((c, i) => (
                  <tr key={i} className="border-b border-zinc-900 hover:bg-zinc-900/50 cursor-pointer" onClick={() => setSel(c)}>
                    {TABLE_COLS.map(col => <td key={col.key} className={`px-2 py-1 whitespace-nowrap ${col.num ? 'text-right' : ''}`}>{fmt(c[col.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* lead/lag */}
        <section className="card p-4">
          <div className="lbl mb-2">LEAD/LAG ({bundle.leadlag?.length || 0} pairs)</div>
          <div className="overflow-x-auto max-h-56 overflow-y-auto">
            <table className="w-full text-[11px] num">
              <thead><tr className="text-zinc-500 text-left border-b border-zinc-800">
                {['source', 'target', 'lag', 'event_count', 'mean_forward_return', 'WR'].map(k => <th key={k} className="px-2 py-1">{k}</th>)}
              </tr></thead>
              <tbody>{(bundle.leadlag || []).slice(0, 50).map((r, i) => (
                <tr key={i} className="border-b border-zinc-900"><td className="px-2 py-1">{fmt(r.source)}</td><td className="px-2 py-1">{fmt(r.target)}</td><td className="px-2 py-1 text-right">{fmt(r.lag)}</td><td className="px-2 py-1 text-right">{fmt(r.event_count)}</td><td className="px-2 py-1 text-right">{fmt(r.mean_forward_return)}</td><td className="px-2 py-1 text-right">{fmt(r.WR)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        {/* filter pipeline + paper */}
        <section className="card p-4">
          <div className="lbl mb-2">FILTER PIPELINE · PAPER ELIGIBILITY</div>
          <div className="text-[11px] num flex flex-col gap-0.5">
            {(bundle.filter_log || []).map((f, i) => (
              <div key={i} className="flex gap-2"><span className="text-zinc-500 w-40">{f.filter}</span><span>in={f.input_count}</span><span className="text-emerald-300">passed={f.passed_count}</span><span className="text-red-300">rejected={f.rejected_count}</span><span className="text-zinc-500">{f.rejection_reason}</span></div>
            ))}
          </div>
        </section>
      </main>

      {/* candidate detail */}
      {sel && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={() => setSel(null)}>
          <div className="bg-[#14141a] border border-zinc-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2"><h2 className="text-white font-semibold num">{String(sel.candidate)}</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400">{String(sel.final_status)}</span>
              <button className="ml-auto text-zinc-500 hover:text-white" onClick={() => setSel(null)}>✕</button></div>
            <div className="lbl mt-3 mb-1">EXACT FORMULA</div>
            <pre className="text-[11px] num bg-[#0d0d12] border border-zinc-800 rounded p-2 whitespace-pre-wrap">{String(sel.formula || sel.feature_definition)}</pre>
            <div className="grid grid-cols-2 gap-3 mt-3 text-[11px] num">
              <div><div className="lbl mb-1">EQUITY (net pnl)</div><Spark data={sel.equity_curve} stroke="#34d399" /></div>
              <div><div className="lbl mb-1">DRAWDOWN</div><Spark data={sel.drawdown_curve} stroke="#f87171" /></div>
            </div>
            <div className="lbl mt-3 mb-1">ALL METRICS</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-[11px] num">
              {Object.entries(sel).filter(([k]) => !['equity_curve', 'drawdown_curve', 'formula'].includes(k)).map(([k, v]) => (
                <div key={k} className="bg-[#0d0d12] border border-zinc-800 rounded px-2 py-1"><span className="text-zinc-500">{k}</span> <span className="text-zinc-200">{fmt(v)}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
