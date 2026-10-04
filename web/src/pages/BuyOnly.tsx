import { useEffect, useRef, useState } from 'react';

// BUY ONLY tab — long-options-only backtesting console.
//
// Same UX contract as the Discovery tab: upload a CSV (or load the shipped
// sample) → configure → run → live streamed log → results → download.
//
// The engine is the PYTHON implementation (xbost_option_discovery/buyonly),
// executed server-side by POST /api/buyonly and streamed back over SSE. This
// page renders exactly what that engine measured; it recomputes nothing, so the
// screen can never disagree with the CLI.

type Cfg = {
  maxLots: number; lotSize: number; maxItmSteps: number; targetItmSteps: number;
  minStopPoints: number; breakevenPoints: number; brokeragePerOrder: number;
  targetR: number; maxHoldBars: number; maxConsecutiveLosses: number;
  timingPerms: number; sensitivity: boolean; noRegimeRestrict: boolean;
  logLevel: string; hypothesis: string;
};

const DEFAULT_CFG: Cfg = {
  maxLots: 5, lotSize: 15, maxItmSteps: 2, targetItmSteps: 1,
  minStopPoints: 30, breakevenPoints: 2.5, brokeragePerOrder: 20,
  targetR: 2, maxHoldBars: 45, maxConsecutiveLosses: 2,
  timingPerms: 20, sensitivity: false, noRegimeRestrict: false,
  logLevel: 'info', hypothesis: '',
};

const HYPOTHESES = ['', 'VOLATILITY_COIL', 'OI_VELOCITY', 'LIQUIDITY_FLUSH', 'VWAP_SNAP_BACK'];

const LEDGER_COLS: { key: string; label: string; num: boolean }[] = [
  { key: 'trade_id', label: '#', num: true },
  { key: 'entry_time', label: 'Entry', num: false },
  { key: 'hypothesis', label: 'Hypothesis', num: false },
  { key: 'regime', label: 'Regime', num: false },
  { key: 'direction', label: 'Side', num: false },
  { key: 'contract', label: 'Contract', num: false },
  { key: 'moneyness', label: 'ITM?', num: false },
  { key: 'entry_price', label: 'Entry px', num: true },
  { key: 'exit_price', label: 'Exit px', num: true },
  { key: 'exit_reason', label: 'Exit', num: false },
  { key: 'duration_bars', label: 'Bars', num: true },
  { key: 'risk_points', label: 'Risk', num: true },
  { key: 'gross_points', label: 'Gross', num: true },
  { key: 'cost_points', label: 'Cost', num: true },
  { key: 'net_points', label: 'Net', num: true },
  { key: 'net_pct', label: 'Net %', num: true },
  { key: 'mfe_points', label: 'MFE', num: true },
  { key: 'mae_points', label: 'MAE', num: true },
  { key: 'be_moved', label: 'BE', num: false },
  { key: 'profit_locked', label: 'Lock', num: false },
  { key: 'time_to_target_bars', label: 'T2T', num: true },
  { key: 'rupee_pnl', label: '₹', num: true },
];

function fmt(v: any): string {
  if (v === null || v === undefined || v === 'NA') return 'NA';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (isNaN(v)) return 'NA';
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  const s = String(v);
  return s.length > 40 ? s.slice(0, 40) + '…' : s;
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
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

function Tile({ label, value, tone }: { label: string; value: any; tone?: 'good' | 'bad' | 'flat' }) {
  const cls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : 'text-zinc-200';
  return (
    <div className="rounded border border-[#232329] bg-[#12121a] px-3 py-2 min-w-[112px]">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{fmt(value)}</div>
    </div>
  );
}

export default function BuyOnly() {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);
  const [fileName, setFileName] = useState('');
  const [csvText, setCsvText] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [stage, setStage] = useState('');
  const [prog, setProg] = useState(0);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  const [showSignals, setShowSignals] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [q, setQ] = useState('');
  const [hypF, setHypF] = useState('ALL');
  const [sortK, setSortK] = useState('trade_id');
  const [sortD, setSortD] = useState(1);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const pushLog = (line: string) => setLog(p => [...p.slice(-6000), line]);

  const set = (k: keyof Cfg, v: any) => setCfg(c => ({ ...c, [k]: v }));

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const f = files[0];
    setFileName(f.name);
    setCsvText(await f.text());
    setRes(null);
    pushLog(`source: uploaded ${f.name} (${(f.size / 1024).toFixed(0)} KB)`);
  };

  const loadSample = async () => {
    pushLog('source: fetching shipped sample-banknifty-options.csv …');
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

  const loadBundle = async () => {
    pushLog('loading shipped buyonly-bundle.json (precomputed reference run)…');
    try {
      const r = await fetch('./buyonly-bundle.json');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.json();
      setRes(b);
      setFileName('buyonly-bundle.json (precomputed)');
      (b.log_text || b.log || []).forEach((l: string) => pushLog(l));
      pushLog(`bundle loaded: run ${b.run_id}, ${b.summary?.trades ?? 0} trades`);
    } catch (e: any) {
      setErr(`Bundle fetch failed: ${e?.message || e}. Run the engine instead.`);
    }
  };

  const run = async () => {
    if (!csvText) { setErr('Upload an options CSV or load the sample first.'); return; }
    setErr(null); setRes(null); setLog([]); setRunning(true); setProg(0); setStage('starting');
    const ac = new AbortController();
    abortRef.current = ac;
    pushLog(`run requested: lots≤${cfg.maxLots} lot=${cfg.lotSize} ` +
      `itm≤${cfg.maxItmSteps} targetItm=${cfg.targetItmSteps} stop≥${cfg.minStopPoints}pts ` +
      `BE=${cfg.breakevenPoints}pts+brokerage target=${cfg.targetR}R hold≤${cfg.maxHoldBars} ` +
      `lossLimit=${cfg.maxConsecutiveLosses} logLevel=${cfg.logLevel}`);
    pushLog('note: futures are not uploaded by this tab, so ATM comes from put-call parity.');
    try {
      const r = await fetch('/api/buyonly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, cfg }),
        signal: ac.signal,
      });
      if (!r.ok) {
        let m = `HTTP ${r.status}`;
        try { m = (await r.json()).error || m; } catch { /* keep status */ }
        throw new Error(m);
      }
      if (!r.body) throw new Error('no response body (stream unsupported)');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        const frames = pending.split('\n\n');
        pending = frames.pop() || '';
        for (const fr of frames) {
          const line = fr.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let m: any;
          try { m = JSON.parse(line.slice(6)); } catch { continue; }
          if (m.type === 'log') pushLog(m.line);
          else if (m.type === 'progress') { setStage(`${m.kind}: ${m.stage}`); setProg(p => Math.min(0.99, p + 0.02)); }
          else if (m.type === 'done') {
            setRes(m.bundle);
            setProg(1); setStage('done');
            (m.bundle.log_text || []).forEach((l: string) => pushLog(l));
            pushLog(`DONE run=${m.bundle.run_id} wallMs=${m.bundle.wall_ms} trades=${m.bundle.summary?.trades ?? 0}`);
            setRunning(false);
          } else if (m.type === 'error') {
            setErr(m.message); setRunning(false);
            pushLog(`ERROR: ${m.message}`);
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') { setErr(String(e?.message || e)); setRunning(false); }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    pushLog('STOPPED by user (server-side python process may finish and be discarded)');
  };

  const s = res?.summary || {};
  const timing = res?.timing_test || null;
  const sens = res?.sensitivity || null;

  const rows = (() => {
    let r = ((res?.ledger || []) as Record<string, any>[]).slice();
    for (const x of r) {
      if (x.contract === undefined && x.symbol !== undefined) {
        x.contract = `${x.symbol}@${Number(x.strike).toFixed(0)}`;
      }
    }
    if (hypF !== 'ALL') r = r.filter(x => String(x.hypothesis) === hypF);
    if (q) r = r.filter(x => JSON.stringify(x).toLowerCase().includes(q.toLowerCase()));
    r.sort((a, b) => {
      const x = a[sortK], y = b[sortK];
      if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) return (x - y) * sortD;
      return String(x ?? '').localeCompare(String(y ?? '')) * sortD;
    });
    return r;
  })();

  const hyps = ['ALL', ...Array.from(new Set(((res?.ledger || []) as any[]).map(c => String(c.hypothesis))))];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const downloadAll = () => {
    if (!res) return;
    dl(`buyonly-log-${stamp}.txt`, (res.log_text || res.log || []).join('\n'));
    dl(`buyonly-ledger-${stamp}.csv`, toCSV(res.ledger || []), 'text/csv');
    dl(`buyonly-signals-${stamp}.csv`, toCSV(res.signals || []), 'text/csv');
    dl(`buyonly-bundle-${stamp}.json`, JSON.stringify(res, null, 1), 'application/json');
    dl(`buyonly-config-${stamp}.json`, JSON.stringify(res.settings || cfg, null, 1), 'application/json');
  };

  const verdictBad = !res || (s.profit_factor !== undefined && !(Number(s.profit_factor) > 1));

  return (
    <div className="min-h-screen bg-[#0d0d12] text-zinc-300">
      <header className="border-b border-[#232329] px-4 py-3 flex items-center gap-3">
        <h1 className="text-sm font-semibold text-zinc-100">Buy Only — Option Buy-Only Backtester</h1>
        <span className="text-[11px] text-zinc-500">
          long options only · ATM/ITM · max {cfg.maxLots} lots · BE = brokerage + {cfg.breakevenPoints} pts · no RSI/MACD/MA-crossover
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-ghost btn-xs" disabled={running} onClick={run}>▶ Run</button>
          <button className="btn-ghost btn-xs" disabled={!running} onClick={stop}>■ Stop</button>
          <button className="btn-ghost btn-xs" disabled={!res} onClick={downloadAll}>⤓ Download all</button>
        </div>
      </header>

      <div className="px-4 py-3 space-y-3">
        {/* ---------- source ---------- */}
        <section className="flex flex-wrap items-center gap-2 text-xs">
          <label className="btn-ghost btn-xs cursor-pointer">
            ⤒ Upload options CSV
            <input type="file" accept=".csv,text/csv" className="hidden" disabled={running}
              onChange={e => onUpload(e.target.files)} />
          </label>
          <button className="btn-ghost btn-xs" onClick={loadSample} disabled={running}>Load sample</button>
          <button className="btn-ghost btn-xs" onClick={loadBundle} disabled={running}>Load precomputed bundle</button>
          {fileName && <span className="text-zinc-500">· {fileName}</span>}
        </section>

        {/* ---------- config ---------- */}
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2 text-xs">
          {([
            ['maxLots', 'Max lots'], ['lotSize', 'Lot size'],
            ['targetItmSteps', 'Target ITM steps'], ['maxItmSteps', 'Max ITM steps'],
            ['minStopPoints', 'Min stop (pts)'], ['breakevenPoints', 'BE buffer (pts)'],
            ['brokeragePerOrder', 'Brokerage/order'], ['targetR', 'Target (R)'],
            ['maxHoldBars', 'Max hold (bars)'], ['maxConsecutiveLosses', 'Loss limit'],
            ['timingPerms', 'Timing perms'],
          ] as [keyof Cfg, string][]).map(([k, label]) => (
            <label key={String(k)} className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</span>
              <input type="number" disabled={running} value={String(cfg[k])}
                onChange={e => set(k, Number(e.target.value))}
                className="bg-[#12121a] border border-[#232329] rounded px-2 py-1 text-zinc-200" />
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Log level</span>
            <select disabled={running} value={cfg.logLevel}
              onChange={e => set('logLevel', e.target.value)}
              className="bg-[#12121a] border border-[#232329] rounded px-2 py-1 text-zinc-200">
              {['quiet', 'info', 'debug', 'trace'].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Hypothesis</span>
            <select disabled={running} value={cfg.hypothesis}
              onChange={e => set('hypothesis', e.target.value)}
              className="bg-[#12121a] border border-[#232329] rounded px-2 py-1 text-zinc-200">
              {HYPOTHESES.map(v => <option key={v || 'ALL'} value={v}>{v || 'ALL'}</option>)}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input type="checkbox" disabled={running} checked={cfg.sensitivity}
              onChange={e => set('sensitivity', e.target.checked)} />
            <span>sensitivity sweep</span>
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input type="checkbox" disabled={running} checked={cfg.noRegimeRestrict}
              onChange={e => set('noRegimeRestrict', e.target.checked)} />
            <span>disable regime filter</span>
          </label>
        </section>

        {err && <div className="rounded border border-red-900 bg-red-950/30 px-3 py-2 text-xs text-red-300">{err}</div>}

        {/* ---------- progress ---------- */}
        {running && (
          <section className="space-y-1">
            <div className="h-1.5 w-full rounded bg-[#1b1b23] overflow-hidden">
              <div className="h-full bg-emerald-600 transition-all" style={{ width: `${Math.round(prog * 100)}%` }} />
            </div>
            <div className="text-[11px] text-zinc-500">{stage || 'running python engine…'}</div>
          </section>
        )}

        {/* ---------- headline ---------- */}
        {res && (
          <>
            <section className="flex flex-wrap gap-2">
              <Tile label="Trades" value={s.trades} />
              <Tile label="Win rate" value={s.win_rate === null ? 'NA' : `${s.win_rate}%`} tone={Number(s.win_rate) >= 50 ? 'good' : 'flat'} />
              <Tile label="Profit factor" value={s.profit_factor} tone={Number(s.profit_factor) > 1 ? 'good' : 'bad'} />
              <Tile label="Max DD (pts)" value={s.max_dd_points} tone="bad" />
              <Tile label="Time to target" value={s.time_to_target_bars === null ? 'NA' : `${s.time_to_target_bars} bars`} />
              <Tile label="Reached target" value={s.reached_target === undefined ? 'NA' : `${s.reached_target}/${s.trades}`} />
              <Tile label="Net pts" value={s.net_points} tone={Number(s.net_points) > 0 ? 'good' : 'bad'} />
              <Tile label="Net ₹" value={s.rupee_pnl} tone={Number(s.rupee_pnl) > 0 ? 'good' : 'bad'} />
              <Tile label="Avg dur" value={s.avg_duration_bars} />
              <Tile label="BE armed" value={`${s.be_armed_rate}%`} />
              <Tile label="50% lock" value={`${s.profit_locked_rate}%`} />
            </section>

            <section className="text-xs flex flex-wrap items-center gap-2">
              <span className={verdictBad
                ? 'rounded border border-amber-800 bg-amber-950/30 px-2 py-1 text-amber-300'
                : 'rounded border border-emerald-800 bg-emerald-950/30 px-2 py-1 text-emerald-300'}>
                read the significance and sensitivity panels before trusting these numbers
              </span>
              <span className="text-zinc-500">run {res.run_id} · {res.wall_ms} ms · log {res.log_level}
                {res.log_counts && <> · {Object.values(res.log_counts).reduce((a: any, b: any) => a + b, 0)} events</>}
              </span>
            </section>

            {/* ---------- significance ---------- */}
            <section className="rounded border border-[#232329] bg-[#12121a] p-3 text-xs space-y-1">
              <div className="text-zinc-100 font-semibold">Significance</div>
              <div className="text-zinc-400">
                mean net per trade = {fmt(res.significance?.mean)} pts ·
                95% CI = [{fmt(res.significance?.lo)}, {fmt(res.significance?.hi)}] ·
                excludes zero = <span className={res.significance?.excludes_zero ? 'text-emerald-300' : 'text-amber-300'}>{String(res.significance?.excludes_zero)}</span>
              </div>
              {timing && (
                <div className="text-zinc-400">
                  entry-timing test (re-timed signals, engine re-run per permutation): observed{' '}
                  {fmt(timing.observed_net)} vs null mean {fmt(timing.null_mean)} (sd {fmt(timing.null_sd)}) ·
                  p = <span className={Number(timing.p_value) < 0.05 ? 'text-emerald-300' : 'text-amber-300'}>{fmt(timing.p_value)}</span>
                  {' '}· {timing.status}
                </div>
              )}
              <div className="text-zinc-600">
                A ledger-level permutation test is not used: the mean of a permuted return series is
                invariant, so that null always equals the observation.
              </div>
            </section>

            {/* ---------- sensitivity ---------- */}
            {sens && (
              <section className="rounded border border-[#232329] bg-[#12121a] p-3 text-xs space-y-1">
                <div className="text-zinc-100 font-semibold">Parameter sensitivity</div>
                <div className="text-zinc-400">
                  WR {fmt(sens.win_rate_min)}–{fmt(sens.win_rate_max)}% · net {fmt(sens.net_min)}–{fmt(sens.net_max)} pts ·
                  profitable {sens.configs_profitable}/{sens.configs_total}
                </div>
                {Number(sens.net_min) < 0 && Number(sens.net_max) > 0 && (
                  <div className="text-amber-300">
                    Profitability flips sign across the grid — the best cell is a noise pocket, not an edge.
                  </div>
                )}
                <table className="w-full text-[11px] mt-1">
                  <thead className="text-zinc-500">
                    <tr>
                      {['param', 'value', 'trades', 'WR%', 'PF', 'net'].map(h =>
                        <th key={h} className="text-left py-0.5 px-1">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(sens.rows || []).map((r: any, i: number) => (
                      <tr key={i} className="border-t border-[#1b1b23]">
                        <td className="px-1">{r.param}</td><td className="px-1">{r.value}</td>
                        <td className="px-1">{r.trades}</td><td className="px-1">{r.win_rate}</td>
                        <td className="px-1">{r.profit_factor}</td>
                        <td className={`px-1 ${Number(r.net_points) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>{r.net_points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* ---------- hypotheses ---------- */}
            <section className="rounded border border-[#232329] bg-[#12121a] p-3 text-xs space-y-1">
              <div className="text-zinc-100 font-semibold">Hypotheses</div>
              <table className="w-full text-[11px]">
                <thead className="text-zinc-500">
                  <tr>{['hypothesis', 'n', 'WR%', 'PF', 'net', 'avg dur', 'reached target'].map(h =>
                    <th key={h} className="text-left py-0.5 px-1">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {(res.by_hypothesis || []).map((r: any) => (
                    <tr key={r.label} className="border-t border-[#1b1b23]">
                      <td className="px-1 text-zinc-200">{r.label}</td>
                      <td className="px-1">{r.trades}</td>
                      <td className="px-1">{r.win_rate}</td>
                      <td className="px-1">{r.profit_factor}</td>
                      <td className={`px-1 ${Number(r.net_points) > 0 ? 'text-emerald-300' : 'text-red-300'}`}>{r.net_points}</td>
                      <td className="px-1">{r.avg_duration_bars}</td>
                      <td className="px-1">{r.reached_target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {res.availability && Object.entries(res.availability).some(([, v]) => !String(v).startsWith('AVAILABLE')) && (
                <div className="text-zinc-500">
                  {Object.entries(res.availability).filter(([, v]) => !String(v).startsWith('AVAILABLE'))
                    .map(([k, v]) => <div key={k}>· {k}: {String(v)}</div>)}
                </div>
              )}
            </section>

            {/* ---------- regimes + gate breakdown ---------- */}
            <section className="grid md:grid-cols-2 gap-2 text-xs">
              <div className="rounded border border-[#232329] bg-[#12121a] p-3">
                <div className="text-zinc-100 font-semibold mb-1">Regimes</div>
                {Object.entries(res.regimes || {}).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span>{k}</span><span>{fmt(v)}</span></div>
                ))}
                <div className="text-zinc-500 mt-1">underlying: {JSON.stringify(res.underlying_source)}</div>
                <div className="text-zinc-500">moneyness: {JSON.stringify(res.moneyness)}</div>
              </div>
              <div className="rounded border border-[#232329] bg-[#12121a] p-3">
                <div className="text-zinc-100 font-semibold mb-1">Adaptive engine</div>
                <div className="text-zinc-400">signals in: {fmt(res.audit?.signals_in)} · trades: {fmt(res.audit?.trades)}</div>
                {Object.entries(res.audit?.blocked || {}).sort().map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span className="text-zinc-500">{k}</span><span>{fmt(v)}</span></div>
                ))}
              </div>
            </section>

            {/* ---------- ledger ---------- */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select value={hypF} onChange={e => setHypF(e.target.value)} className="bg-[#12121a] border border-[#232329] rounded px-2 py-1">
                  {hyps.map(h => <option key={h}>{h}</option>)}
                </select>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter ledger…"
                  className="bg-[#12121a] border border-[#232329] rounded px-2 py-1" />
                <span className="text-zinc-500">{rows.length} rows</span>
                <button className="btn-ghost btn-xs" onClick={() => setShowSignals(v => !v)}>
                  {showSignals ? 'Hide' : 'Show'} all signals ({res.signals?.length ?? 0})
                </button>
                <button className="btn-ghost btn-xs" onClick={() => setShowMap(v => !v)}>
                  {showMap ? 'Hide' : 'Show'} logic map
                </button>
              </div>
              <div className="overflow-auto max-h-[420px] rounded border border-[#232329]">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#12121a] text-zinc-500">
                    <tr>{LEDGER_COLS.map(c => (
                      <th key={c.key} className="text-left py-1 px-1.5 cursor-pointer select-none"
                        onClick={() => {
                          if (sortK === c.key) setSortD(d => -d);
                          else { setSortK(c.key); setSortD(1); }
                        }}>
                        {c.label}{sortK === c.key ? (sortD > 0 ? ' ▲' : ' ▼') : ''}
                      </th>))}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-[#17171f] hover:bg-[#15151d]">
                        {LEDGER_COLS.map(c => (
                          <td key={c.key} className={
                            c.key === 'net_points' ? (Number(r[c.key]) > 0 ? 'text-emerald-300' : 'text-red-300') :
                              c.key === 'exit_reason' ? 'text-zinc-400' : ''}>
                            {fmt(r[c.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {showMap && (
              <section className="rounded border border-[#232329] bg-[#12121a] p-3">
                <div className="text-xs text-zinc-100 font-semibold mb-1">Logic map</div>
                <pre className="text-[11px] whitespace-pre-wrap text-zinc-400">{res.logic_map}</pre>
              </section>
            )}

            {showSignals && (
              <section className="rounded border border-[#232329] bg-[#12121a] p-3">
                <div className="text-xs text-zinc-100 font-semibold mb-1">
                  All signals ({res.signals?.length ?? 0}) — before the adaptive engine filtered them
                </div>
                <div className="overflow-auto max-h-[320px]">
                  <table className="w-full text-[11px]">
                    <thead className="text-zinc-500">
                      <tr>{['timestamp', 'hypothesis', 'direction', 'detail'].map(h =>
                        <th key={h} className="text-left py-0.5 px-1">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {(res.signals || []).map((r: any, i: number) => (
                        <tr key={i} className="border-t border-[#1b1b23]">
                          <td className="px-1">{fmt(r.timestamp)}</td>
                          <td className="px-1">{fmt(r.hypothesis)}</td>
                          <td className="px-1">{fmt(r.direction)}</td>
                          <td className="px-1 text-zinc-500">{fmt(r.detail)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {/* ---------- live log ---------- */}
        <section className="rounded border border-[#232329] bg-[#0a0a0f]">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#232329]">
            <span className="text-xs text-zinc-300">Run log</span>
            <div className="flex gap-2">
              <span className="text-[10px] text-zinc-600">{log.length} lines</span>
              <button className="btn-ghost btn-xs" onClick={() => dl(`buyonly-log-${stamp}.txt`, log.join('\n'))}>⤓ log</button>
              <button className="btn-ghost btn-xs" onClick={() => setLog([])}>clear</button>
            </div>
          </div>
          <div ref={logRef} className="overflow-auto max-h-[380px] px-3 py-2 font-mono text-[11px] leading-5 text-zinc-400">
            {log.length === 0
              ? <span className="text-zinc-600">no run yet — upload a CSV or load the sample, then press Run.</span>
              : log.map((l, i) => {
                const kind = /^\[\s*[\d.]+s\]\s+(\w+)/.exec(l)?.[1] || '';
                const cls = kind === 'TRADE' ? 'text-emerald-300/90'
                  : kind === 'GATE' ? 'text-amber-300/80'
                    : kind === 'VERDICT' ? 'text-red-300'
                      : kind === 'SIGNAL' ? 'text-sky-300/80'
                        : kind === 'STAT' ? 'text-violet-300/80'
                          : kind === 'DATA' || kind === 'RUN' ? 'text-zinc-300'
                            : kind === 'REGIME' ? 'text-teal-300/80'
                              : kind === 'SELECT' ? 'text-cyan-300/80'
                                : 'text-zinc-500';
                return <div key={i} className={cls}>{l}</div>;
              })}
          </div>
        </section>
      </div>
    </div>
  );
}