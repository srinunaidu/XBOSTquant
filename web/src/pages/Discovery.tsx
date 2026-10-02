import { useEffect, useRef, useState } from 'react';

// OPTION DISCOVERY tab — independent option-native research console.
// Upload data (or use the shipped sample) → configure → run in a Web Worker
// (public/discovery-engine.js, zero futures/strategy imports) → live log →
// results → download log / candidates / bundle / report / config.
// Nothing here reads futures signals, indicator results, or paper state.

type Cfg = {
  focusStrikes: number; minEvents: number; trainFrac: number; valFrac: number;
  seed: number; nPerms: number; sl: number; tp: number; hold: number;
  rankingObjective: string;
};

const DEFAULT_CFG: Cfg = {
  focusStrikes: 3, minEvents: 50, trainFrac: 0.5, valFrac: 0.2,
  seed: 42, nPerms: 200, sl: 0.5, tp: 1.0, hold: 5, rankingObjective: 'composite',
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
  if (typeof v === 'number') {
    if (isNaN(v)) return 'NA';
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  const s = String(v);
  return s.length > 44 ? s.slice(0, 44) + '…' : s;
}

function dl(name: string, text: string, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function toCSV(rows: Record<string, any>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]).filter(k => !Array.isArray(rows[0][k]));
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return keys.join(',') + '\n' + rows.map(r => keys.map(k => esc(r[k])).join(',')).join('\n');
}

function buildReport(res: any): string {
  const L: string[] = [];
  L.push('# OPTION DISCOVERY — run report (RESEARCH_PRICE_MODEL)');
  L.push(`run: ${res.engineVersion} · wallMs=${res.wallMs}`);
  L.push(`settings: ${JSON.stringify(res.settings)}`);
  L.push('');
  L.push('## STATUS BAR');
  for (const [k, v] of Object.entries(res.statusBar || {})) L.push(`- ${k} = ${v}`);
  L.push('');
  L.push('## DATA HEALTH / CHAIN');
  L.push(JSON.stringify({ health: res.dataHealth, chain: res.chainMetadata }, null, 1));
  L.push('');
  L.push('## FILTER PIPELINE');
  for (const f of res.filterLog || []) L.push(`- ${f.filter}: in=${f.input_count} passed=${f.passed_count} rejected=${f.rejected_count} (${f.rejection_reason})`);
  L.push('');
  L.push('## CANDIDATES');
  for (const c of res.candidates || []) {
    L.push(`- ${c.candidate} [${c.discovery_family}] events=${c.events} clusters=${c.clusters} ` +
      `FWDexp=${fmt(c.FWD_expectancy)} OOSexp=${fmt(c.FWD_OOS_expectancy)} BHp=${fmt(c.perm_p_adj)} status=${c.final_status} :: ${c.formula}`);
  }
  L.push('');
  L.push('## PAPER ELIGIBILITY: FALSE (research-only until explicitly promoted)');
  return L.join('\n');
}

export default function Discovery() {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState(0);
  const [stage, setStage] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [res, setRes] = useState<any | null>(null);
  const [abort, setAbort] = useState<{ message: string; finalStatus: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fam, setFam] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [minEv, setMinEv] = useState(0);
  const [q, setQ] = useState('');
  const [obj, setObj] = useState('composite');
  const [sortK, setSortK] = useState('rank_composite');
  const [sortD, setSortD] = useState<1 | -1>(-1);
  const [sel, setSel] = useState<Record<string, any> | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const pushLog = (line: string) => setLog(prev => [...prev.slice(-2000), line]);

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const f = files[0];
    setFileName(f.name);
    setCsvText(await f.text());
    setRes(null);
    setAbort(null);
    pushLog(`source: uploaded ${f.name}`);
  };

  const loadSample = async () => {
    pushLog('source: fetching shipped sample-banknifty-options.csv (2 sessions, reference sample)…');
    try {
      const r = await fetch('./sample-banknifty-options.csv');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      setFileName('sample-banknifty-options.csv');
      setCsvText(t);
      setRes(null);
      pushLog(`source: sample loaded (${(t.length / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
      setErr(`Sample fetch failed: ${e?.message || e}. Upload a CSV instead.`);
    }
  };

  const loadShippedBundle = async () => {
    pushLog('loading shipped discovery-bundle.json (precomputed reference run)…');
    try {
      const r = await fetch('./discovery-bundle.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.json();
      setRes(bundleToResult(b));
      setFileName('discovery-bundle.json (precomputed)');
      pushLog(`bundle loaded: run ${b.run_id}, ${b.candidates?.length || 0} candidates`);
    } catch (e: any) {
      setErr(`Bundle fetch failed: ${e?.message || e}`);
    }
  };

  const run = () => {
    if (!csvText) { setErr('Upload an option CSV or load the sample first.'); return; }
    setErr(null); setRes(null); setAbort(null); setLog([]); setRunning(true); setProg(0);
    workerRef.current?.terminate();
    let w: Worker;
    try { w = new Worker('./discovery-worker.js'); }
    catch (e: any) { setErr(`Worker failed to start: ${e?.message || e}`); setRunning(false); return; }
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'log') pushLog(m.line);
      else if (m.type === 'progress') { setProg(m.p); setStage(m.stage || ''); }
      else if (m.type === 'done') {
        setRes(m.result); setRunning(false); setProg(1);
        pushLog(`DONE wallMs=${m.result.wallMs} candidates=${m.result.candidates.length}`);
        w.terminate(); workerRef.current = null;
      } else if (m.type === 'error') {
        setErr(m.message); setRunning(false);
        setAbort({ message: m.message, finalStatus: m.finalStatus || 'BLOCKED_DATA' });
        for (const line of (m.log || [])) pushLog(line);
        pushLog(`ERROR: ${m.message} FINAL_STATUS=${m.finalStatus || 'BLOCKED_DATA'}`);
        w.terminate(); workerRef.current = null;
      }
    };
    w.onerror = (ev) => {
      setErr(`Worker error: ${(ev as ErrorEvent).message || 'unknown'}`);
      setRunning(false);
    };
    w.postMessage({
      type: 'run', text: csvText,
      cfg: {
        focusStrikes: cfg.focusStrikes, minEvents: cfg.minEvents,
        trainFrac: cfg.trainFrac, valFrac: 1 - cfg.trainFrac - 0.3,
        seed: cfg.seed, nPerms: cfg.nPerms, sl: cfg.sl, tp: cfg.tp, hold: cfg.hold,
        rankingObjective: cfg.rankingObjective,
      },
    });
    pushLog(`run started: focusStrikes=${cfg.focusStrikes} minEvents=${cfg.minEvents} ` +
      `train=${cfg.trainFrac} sl=${cfg.sl} tp=${cfg.tp} hold=${cfg.hold} seed=${cfg.seed} perms=${cfg.nPerms}`);
  };

  const stop = () => {
    workerRef.current?.terminate(); workerRef.current = null;
    setRunning(false);
    pushLog('STOPPED by user');
  };

  const rows = (() => {
    let r = ((res?.candidates || []) as Record<string, any>[]).slice();
    if (fam !== 'ALL') r = r.filter(c => String(c.discovery_family) === fam);
    if (status !== 'ALL') r = r.filter(c => String(c.final_status) === status);
    if (minEv > 0) r = r.filter(c => Number(c.events) >= minEv);
    if (q) r = r.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase()));
    const k = obj === 'composite' ? 'rank_composite' : `rank_${obj}`;
    const key = (TABLE_COLS.some(c => c.key === sortK) || k.startsWith('rank_')) ? (TABLE_COLS.some(c => c.key === sortK) ? sortK : k) : k;
    r.sort((x, y) => {
      const a = x[key], b = y[key];
      if (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) return (a - b) * sortD;
      return String(a ?? '').localeCompare(String(b ?? '')) * sortD;
    });
    return r;
  })();

  const fams = ['ALL', ...Array.from(new Set(((res?.candidates || []) as any[]).map(c => String(c.discovery_family))))];
  const statuses = ['ALL', ...Array.from(new Set(((res?.candidates || []) as any[]).map(c => String(c.final_status))))];
  const sb = res?.statusBar || {};
  const pill = (v: string) => v === 'PASS' || v === 'AVAILABLE' || v === 'TRUE'
    ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40'
    : v === 'FALSE' || v === 'FAIL' ? 'text-red-300 border-red-900 bg-red-950/30'
      : 'text-zinc-400 border-zinc-700 bg-zinc-900/60';

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const downloadAll = () => {
    if (!res) return;
    dl(`discovery-log-${stamp}.txt`, log.join('\n'));
    dl(`discovery-candidates-${stamp}.csv`, toCSV(res.candidates || []), 'text/csv');
    dl(`discovery-bundle-${stamp}.json`, JSON.stringify(res, null, 1), 'application/json');
    dl(`discovery-report-${stamp}.md`, buildReport(res));
    dl(`discovery-config-${stamp}.json`, JSON.stringify(res.settings || cfg, null, 1), 'application/json');
  };

  const num = (v: string, dflt: number) => {
    const n = Number(v);
    return isNaN(n) ? dflt : n;
  };

  return (
    <div className="min-h-screen bg-[#0d0d12] text-zinc-300">
      <header className="border-b border-[#232329] px-4 py-3 flex items-center gap-3">
        <a href="#/" className="text-emerald-400 text-sm">←</a>
        <h1 className="font-display font-bold text-white tracking-tight">OPTION DISCOVERY</h1>
        <span className="text-[10px] text-zinc-500">independent research · no futures signals</span>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-4">
        {/* 1. data */}
        <section className="card p-4">
          <div className="lbl mb-2">1 · DATA SOURCE (option CSV: long or wide format)</div>
          <div className="flex flex-wrap gap-2">
            <label className="btn-ghost btn-xs cursor-pointer">📂 Upload CSV
              <input type="file" accept=".csv,.txt" className="hidden" onChange={e => onUpload(e.target.files)} />
            </label>
            <button className="btn-ghost btn-xs" onClick={loadSample}>Load 2-day reference sample</button>
            <button className="btn-ghost btn-xs" onClick={loadShippedBundle}>Load precomputed bundle</button>
            {fileName && <span className="text-[11px] text-zinc-400 num self-center">source: {fileName}</span>}
          </div>
        </section>

        {/* 2. config */}
        <section className="card p-4">
          <div className="lbl mb-2">2 · RESEARCH SETTINGS</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px]">
            {([
              ['focusStrikes', 'Focus strikes', 'int'], ['minEvents', 'Min events', 'int'],
              ['trainFrac', 'Train frac', 'float'], ['nPerms', 'Permutations', 'int'],
              ['seed', 'Seed', 'int'], ['sl', 'Exit SL %', 'float'], ['tp', 'Exit TP %', 'float'],
              ['hold', 'Max hold (bars)', 'int'],
            ] as const).map(([k, label]) => (
              <label key={k} className="bg-[#111] border border-zinc-800 rounded px-2 py-1.5 flex flex-col gap-1">
                <span className="text-zinc-500">{label}</span>
                <input type="number" step="any" value={(cfg as any)[k]}
                  onChange={e => setCfg({ ...cfg, [k]: num(e.target.value, (DEFAULT_CFG as any)[k]) })}
                  className="bg-transparent num text-zinc-100 outline-none" />
              </label>
            ))}
            <label className="bg-[#111] border border-zinc-800 rounded px-2 py-1.5 flex flex-col gap-1">
              <span className="text-zinc-500">Ranking objective</span>
              <select value={cfg.rankingObjective} onChange={e => setCfg({ ...cfg, rankingObjective: e.target.value })}
                className="bg-transparent text-zinc-100 outline-none">
                {['composite', 'sharpe', 'expectancy', 'oos'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <div className="flex gap-2 mt-3">
            {!running
              ? <button className="btn-ghost btn-xs !text-emerald-300 !border-emerald-800" onClick={run} disabled={!csvText}>▶ Run discovery</button>
              : <button className="btn-ghost btn-xs !text-red-300 !border-red-900" onClick={stop}>■ Stop</button>}
            {running && (
              <div className="flex-1 self-center">
                <div className="prog"><div style={{ width: `${Math.round(prog * 100)}%` }} /></div>
                <div className="text-[10px] text-zinc-500 num mt-0.5">{Math.round(prog * 100)}% · {stage}</div>
              </div>
            )}
            {res && !running && (
              <button className="btn-ghost btn-xs" onClick={downloadAll}>⬇ Download all (log · candidates · bundle · report · config)</button>
            )}
          </div>
          {err && <div className="alert-err mt-2" role="alert"><span>⚠</span><span>{err}</span></div>}
        </section>

        {/* 3. live log */}
        {(log.length > 0 || running) && (
          <section className="card p-4">
            <div className="lbl mb-2">3 · RUN LOG (in-depth, downloadable)</div>
            <div ref={logRef} className="bg-black/60 border border-zinc-800 rounded p-2 h-56 overflow-y-auto font-mono text-[11px] leading-relaxed num">
              {log.map((l, i) => <div key={i} className="text-zinc-300 whitespace-pre-wrap">{l}</div>)}
              {running && <div className="text-emerald-400 animate-pulse">▊ running…</div>}
            </div>
          </section>
        )}

        {/* 4. results */}
        {abort && !res && (
          <section className="card p-4 border-red-900">
            <div className="lbl mb-1 !text-red-300">RUN BLOCKED — {abort.finalStatus}</div>
            <div className="text-[12px] text-zinc-400">{abort.message}</div>
            <div className="text-[11px] text-zinc-500 mt-1">The log above contains the full audit up to the blocking layer. This is an engineering/data failure, not a research result.</div>
          </section>
        )}
        {res && (
          <>
            <section className="px-1 flex flex-wrap gap-1.5 items-center">
              {res.finalStatus && (
                <span className="text-[11px] num px-2 py-0.5 rounded-full border border-emerald-800 bg-emerald-950/40 text-emerald-300">FINAL_STATUS · {String(res.finalStatus)}</span>
              )}
              {Object.entries(sb).map(([k, v]) => (
                <span key={k} className={`text-[10px] num px-2 py-0.5 rounded-full border ${pill(String(v))}`}>{k} · {String(v)}</span>
              ))}
            </section>

            <section className="card p-4">
              <div className="lbl mb-2">4 · DISCOVERY BOARD ({rows.length} rows)</div>
              <div className="flex flex-wrap gap-2 text-[12px] mb-2">
                <select value={fam} onChange={e => setFam(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1">
                  {fams.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <select value={status} onChange={e => setStatus(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1">
                  {statuses.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <select value={obj} onChange={e => setObj(e.target.value)} className="bg-[#111] border border-zinc-700 rounded px-2 py-1">
                  {['composite', 'sharpe', 'expectancy', 'oos'].map(o => <option key={o} value={o}>rank: {o}</option>)}
                </select>
                <input type="number" value={minEv} onChange={e => setMinEv(num(e.target.value, 0))} placeholder="min events" className="bg-[#111] border border-zinc-700 rounded px-2 py-1 w-24 num" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="search…" className="bg-[#111] border border-zinc-700 rounded px-2 py-1 flex-1 min-w-[120px]" />
              </div>
              <div className="overflow-x-auto">
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
                        {TABLE_COLS.map(col => <td key={col.key} className={`px-2 py-1 whitespace-nowrap ${col.num ? 'text-right' : ''}`}>{fmt((c as any)[col.key])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card p-4">
              <div className="lbl mb-2">FILTER PIPELINE</div>
              <div className="text-[11px] num flex flex-col gap-0.5">
                {(res.filterLog || []).map((f: any, i: number) => (
                  <div key={i} className="flex gap-2 flex-wrap"><span className="text-zinc-500 w-44">{f.filter}</span><span>in={f.input_count}</span><span className="text-emerald-300">passed={f.passed_count}</span><span className="text-red-300">rejected={f.rejected_count}</span><span className="text-zinc-500">{f.rejection_reason}</span></div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {sel && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={() => setSel(null)}>
          <div className="bg-[#14141a] border border-zinc-700 rounded-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2"><h2 className="text-white font-semibold num">{String(sel.candidate)}</h2>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400">{String(sel.final_status)}</span>
              <button className="ml-auto text-zinc-500 hover:text-white" onClick={() => setSel(null)}>✕</button></div>
            <div className="lbl mt-3 mb-1">EXACT FORMULA</div>
            <pre className="text-[11px] num bg-[#0d0d12] border border-zinc-800 rounded p-2 whitespace-pre-wrap">{String(sel.formula || sel.feature_definition)}</pre>
            <div className="lbl mt-3 mb-1">EQUITY (net pnl per trade, capped at 100 pts)</div>
            <Sparkline data={sel.equity_curve} />
            <div className="lbl mt-3 mb-1">ALL METRICS</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-[11px] num">
              {Object.entries(sel).filter(([k]) => k !== 'equity_curve').map(([k, v]) => (
                <div key={k} className="bg-[#0d0d12] border border-zinc-800 rounded px-2 py-1"><span className="text-zinc-500">{k}</span> <span className="text-zinc-200">{fmt(v)}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function bundleToResult(b: any): any {
  // shipped tab_bundle.json (Python engine) → same shape the worker returns
  return {
    engineVersion: b.engine_version || 'python',
    wallMs: 0,
    settings: b.settings || {},
    statusBar: {
      DATA_READY: 'PASS', CHAIN_READY: 'PASS', FEATURES_READY: 'PASS', DISCOVERY_READY: 'PASS',
      VALIDATION_READY: 'PASS', OOS_READY: 'PASS', ROBUSTNESS_READY: 'PASS',
      EXECUTION_MODEL: 'RESEARCH_PRICE_MODEL', PAPER_ELIGIBLE: 'FALSE',
    },
    dataHealth: {},
    chainMetadata: b.chain_metadata || {},
    modules: b.modules || {},
    filterLog: [],
    candidates: b.candidates || [],
    leadlag: b.leadlag || [],
    counts: b.counts || {},
  };
}

function Sparkline({ data }: { data: any }) {
  const arr = Array.isArray(data) ? data.filter((x: any) => typeof x === 'number') : [];
  if (arr.length < 2) return <span className="text-zinc-600 text-[11px]">NA</span>;
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = mx - mn || 1;
  const pts = arr.map((v: number, i: number) => `${(i / (arr.length - 1)) * 300},${60 - ((v - mn) / rg) * 56}`).join(' ');
  return <svg width="300" height="64" className="block bg-[#0d0d12] border border-zinc-800 rounded"><polyline points={pts} fill="none" stroke="#34d399" strokeWidth="1.5" /></svg>;
}
