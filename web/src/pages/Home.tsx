import { useEffect, useState } from 'react';
import Header from '../components/Header';
import { useStore } from '../lib/store';
import { useNavigate } from '../lib/router';
import { loadFile, dataHealth } from '../lib/data';
import { useAngelStore } from '../lib/angelStore';
import { fetchCandles, testConnection } from '../lib/angelClient';
import { checkDataHealth, resampleCandles } from '../lib/dataHealth';
import { BUILD_INFO } from '../lib/buildinfo';

// A dataset belongs to the Options Lab if its contract key or source label
// looks like an option contract (…CE / …PE suffix, OPTION token, or an
// options source file). Everything else counts as futures/equity.
export function isOptionsDataset(key: string, label: string): boolean {
  const k = (key || '').toUpperCase();
  const l = (label || '').toUpperCase();
  if (/(CE|PE)$/.test(k.replace(/[^A-Z]/g, ''))) return true;
  if (k.includes('OPTION') || l.includes('OPTION')) return true;
  if (/(^|[^A-Z])(CE|PE)([^A-Z]|$)/.test(k)) return true;
  return false;
}

function fmtBars(n: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}


function AngelDataPanel() {
  const { creds, exchange, symbol, interval, fromDate, toDate, remember, status, error } = useAngelStore();
  const { setCreds, setExchange, setSymbol, setDates, setRemember, setStatus, setJwt } = useAngelStore();
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadingTest, setLoadingTest] = useState(false);
  const [loadingFetch, setLoadingFetch] = useState(false);
  const [fetchData, setFetchData] = useState<unknown>(null);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);

  useEffect(() => {
    try { useAngelStore.getState().hydratate(); } catch {}
  }, []);

  const isTestDisabled = !creds.apiKey || !creds.clientCode || !creds.password || !creds.totpSecret || loadingTest;

  const todayISTStr = (() => {
    const now = new Date();
    const istOffset = 5.5 * 60;
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + istOffset * 60000);
    return ist.toISOString().slice(0, 10);
  })();

  const datesValid = (() => {
    if (!fromDate || !toDate) return false;
    if (toDate < fromDate) return false;
    if (toDate > todayISTStr) return false;
    const d1 = new Date(fromDate);
    const d2 = new Date(toDate);
    const diffDays = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) return false;
    return true;
  })();

  const isFetchDisabled = status !== 'success' || !datesValid || loadingFetch;

  const handleTest = async () => {
    setLocalError(null);
    setLoadingTest(true);
    try {
      const res = await testConnection({
        apiKey: creds.apiKey,
        clientCode: creds.clientCode,
        password: creds.password,
        totpSecret: creds.totpSecret,
      });
      if (res.ok) {
        setStatus('success', null);
        if (res.clientCode) setJwt(res.clientCode);
        setLocalError(null);
      } else {
        setStatus('error', res.error || 'auth_failed');
        setLocalError(res.error || 'auth_failed');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'auth_failed';
      setStatus('error', msg);
      setLocalError(msg);
    } finally {
      setLoadingTest(false);
    }
  };

  const handleFetch = async () => {
    setHealthMsg(null);
    setLocalError(null);
    setLoadingFetch(true);
    try {
      const res = await fetchCandles({ exchange, symbol, interval, fromDate, toDate });
      const raw = (res as { data: unknown[] }).data || [];
      const health = checkDataHealth(raw as unknown as Parameters<typeof checkDataHealth>[0]);
      if (health) {
        setHealthMsg(health);
        setFetchData(raw);
        return;
      }
      const resampled = resampleCandles(raw as unknown as Parameters<typeof resampleCandles>[0], interval);
      setFetchData(resampled);
      // Wire fetched Data[] into existing backtest engine, same resample/health path with dataSource:"angel"
      try {
        const payload = { data: resampled, dataSource: "angel" as const, interval, symbol, exchange, fromDate, toDate };
        // Try server backtest endpoint if available (best-effort)
        const csrfRes = await fetch('/auth/csrf-token', { credentials: 'include' }).catch(() => null);
        let csrf = '';
        try {
          const j = await csrfRes?.json();
          csrf = j?.csrf_token || j?.csrfToken || '';
        } catch {}
        await fetch('/api/backtest/run', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRFToken': csrf } : {}) },
          body: JSON.stringify(payload),
        }).catch(() => {});
        // Also populate XBOST datasets for terminal runner: convert to OHLCV
        try {
          const { useStore } = await import('../lib/store');
          if (resampled && Array.isArray(resampled) && resampled.length) {
            const n = resampled.length;
            const t = new Float64Array(n);
            const o = new Float64Array(n);
            const h = new Float64Array(n);
            const l = new Float64Array(n);
            const c = new Float64Array(n);
            const v = new Float64Array(n);
            for (let i = 0; i < n; i++) {
              const d = resampled[i] as { t: number; o: number; h: number; l: number; c: number; v: number };
              t[i] = d.t; o[i] = d.o; h[i] = d.h; l[i] = d.l; c[i] = d.c; v[i] = d.v;
            }
            const ohlcv = { t, o, h, l, c, v, symbol, layout: 'angel' } as unknown as import('../lib/engine').OHLCV;
            const st = useStore.getState();
            // Register as dataset AND set as active data (so runGrid can use it)
            const datasets = { ...st.datasets };
            const key = symbol || 'ANGEL:' + exchange + ':' + (resampled[0] as { t: number }).t;
            datasets[key] = { raw: ohlcv, label: 'Angel ' + symbol + ' ' + exchange + ' ' + fromDate + '→' + toDate, enabled: true };
            useStore.getState().set({ datasets, raw: ohlcv, data: ohlcv, dataInfo: 'Angel ' + symbol + ' ' + exchange + ' ' + fromDate + '→' + toDate + ' · ' + n.toLocaleString() + ' 1m bars · dataSource:angel', symbol: key });
            // Force data health re-evaluation via store update already
            void payload.dataSource;
          }
        } catch {}
      } catch {}
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'fetch_failed';
      setLocalError(msg);
    } finally {
      setLoadingFetch(false);
    }
  };

  return (
    <section className="card p-4 w-full">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-[7px] h-[7px] rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,146,60,.8)]" />
        <div className="lbl">Angel One — runtime data (authenticated)</div>
        <span className="ml-auto text-[11px] text-zinc-500">ONE_MINUTE · IST · dataSource:angel</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="angel-apiKey" className="text-[11px] text-zinc-400">API Key</label>
          <input id="angel-apiKey" type="password" autoComplete="off" value={creds.apiKey} onChange={(e) => setCreds({ apiKey: e.target.value })} placeholder="API Key" className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50" />
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-clientCode" className="text-[11px] text-zinc-400">Client Code</label>
          <input id="angel-clientCode" type="password" autoComplete="off" value={creds.clientCode} onChange={(e) => setCreds({ clientCode: e.target.value })} placeholder="Client Code" className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50" />
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-password" className="text-[11px] text-zinc-400">Password</label>
          <input id="angel-password" type="password" autoComplete="off" value={creds.password} onChange={(e) => setCreds({ password: e.target.value })} placeholder="Password" className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50" />
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-totpSecret" className="text-[11px] text-zinc-400">TOTP Secret</label>
          <input id="angel-totpSecret" type="password" autoComplete="off" value={creds.totpSecret} onChange={(e) => setCreds({ totpSecret: e.target.value })} placeholder="TOTP Secret" className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 mt-3">
        <div className="space-y-1">
          <label htmlFor="angel-exchange" className="text-[11px] text-zinc-400">Exchange</label>
          <select id="angel-exchange" value={exchange} onChange={(e) => setExchange(e.target.value as typeof exchange)} className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50">
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
            <option value="MCX">MCX</option>
            <option value="NFO">NFO</option>
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-symbol" className="text-[11px] text-zinc-400">Symbol</label>
          <input id="angel-symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="NIFTY" autoComplete="off" className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50" />
          <p className="text-[11px] text-zinc-500">e.g. 99926000</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-interval" className="text-[11px] text-zinc-400">Interval</label>
          <select id="angel-interval" value={interval} disabled className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-400 opacity-60 cursor-not-allowed">
            <option value="ONE_MINUTE">ONE_MINUTE</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        <div className="space-y-1">
          <label htmlFor="angel-fromDate" className="text-[11px] text-zinc-400">From</label>
          <input id="angel-fromDate" type="date" value={fromDate} onChange={(e) => setDates(e.target.value, toDate)} max={todayISTStr} className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
        </div>
        <div className="space-y-1">
          <label htmlFor="angel-toDate" className="text-[11px] text-zinc-400">To</label>
          <input id="angel-toDate" type="date" value={toDate} onChange={(e) => setDates(fromDate, e.target.value)} max={todayISTStr} className="w-full bg-[#111] border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3">
        <input id="angel-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="rounded border-zinc-700" />
        <label htmlFor="angel-remember" className="text-[12px] text-zinc-400">Remember (encrypted)</label>
        <span className="text-[11px] text-zinc-500">Encrypted with SESSION_SECRET; session-only by default.</span>
      </div>

      <div className="flex gap-2 mt-4">
        <button onClick={handleTest} disabled={isTestDisabled} aria-label="Test Connection" className="btn px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-500">
          {loadingTest ? 'Testing...' : 'Test Connection'}
        </button>
        <button onClick={handleFetch} disabled={isFetchDisabled} aria-label="Fetch & Backtest" className="btn px-4 py-2 rounded-md bg-zinc-800 border border-zinc-700 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-700">
          {loadingFetch ? 'Fetching...' : 'Fetch & Backtest'}
        </button>
      </div>

      {(localError || error) && (
        <div className="rounded-md border border-red-900 bg-red-950/30 p-3 text-sm text-red-300 mt-3" role="alert">{localError || error}</div>
      )}
      {status === 'success' && !localError && (
        <div className="rounded-md border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-300 mt-3" role="status">Connection successful</div>
      )}
      {healthMsg && (
        <div className="rounded-md border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-300 mt-3" role="alert">DataHealth: {healthMsg} — backtest blocked.</div>
      )}
      {Array.isArray(fetchData) ? (
        <div className="text-[11px] text-zinc-500 mt-2">Fetched {(fetchData as unknown[]).length} bars · dataSource:angel</div>
      ) : null}
    </section>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const user = useStore(s => s.user);
  const datasets = useStore(s => s.datasets);
  const alert = useStore(s => s.alert);
  const set = useStore(s => s.set);
  const [loadPct, setLoadPct] = useState<number | null>(null);

  const names = Object.keys(datasets);
  const optNames = names.filter(k => isOptionsDataset(k, datasets[k].label));
  const futNames = names.filter(k => !isOptionsDataset(k, datasets[k].label));
  const barsOf = (ks: string[]) => ks.reduce((a, k) => a + (datasets[k].raw.t.length || 0), 0);
  const enabledOf = (ks: string[]) => ks.filter(k => datasets[k].enabled !== false);

  const goTo = (mode: 'futures' | 'options') => {
    useStore.getState().set({ instrumentMode: mode });
    navigate(`#/${mode}`);
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setLoadPct(10);
    let ok = 0, fail: string | null = null;
    for (const f of Array.from(files)) {
      try { await loadFile(f, p => setLoadPct(p)); ok++; }
      catch (e: any) { fail = `"${f.name}": ${e?.message || e}`; }
    }
    setLoadPct(null);
    if (fail) set({ alert: `Could not parse ${fail}. Expected header date,open,high,low,close,volume (or options: date,symbol,strike,otype,expiry,…).` });
    else set({ alert: null });
    if (ok) useStore.getState().set({ boardTick: useStore.getState().boardTick });
  };

  return (
    <div className="min-h-screen bg-[#0d0d12]">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-10 flex flex-col items-center gap-8">
        {/* hero */}
        <div className="text-center">
          <div className="font-display font-bold tracking-tight text-[26px] grad-text">XBOST // QUANT TERMINAL</div>
          <div className="text-[12px] text-zinc-500 tracking-[.18em] uppercase mt-1">
            Nifty · BankNifty · Equities · 1-min OHLCV Engine
          </div>
          <p className="text-zinc-400 text-[13px] mt-3 max-w-xl mx-auto leading-relaxed">
            Pick a desk to enter. Upload data once — futures and options files can coexist;
            each terminal only runs the datasets that belong to it.
          </p>
        </div>

        {/* angel panel - authenticated only */}
        {user && <AngelDataPanel />}

        {/* upload */}
        <section className="card p-4 w-full">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-[7px] h-[7px] rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.8)]" />
            <div className="lbl">Market data — upload 1-min CSV (multi-select)</div>
            {user && <span className="ml-auto text-[11px] text-zinc-500 num">👤 {user.username}</span>}
          </div>
          <label className="block w-full cursor-pointer rounded-lg border border-dashed border-zinc-700 hover:border-emerald-500/60 bg-[#111] px-4 py-5 text-center transition-colors">
            <input type="file" accept=".csv,.txt" multiple className="hidden" onChange={e => onUpload(e.target.files)} />
            <div className="text-[13px] text-zinc-300 font-medium">📂 Click to upload CSV files <span className="text-zinc-500 font-normal">(or drag &amp; drop onto this box)</span></div>
            <div className="text-[11px] text-zinc-500 mt-1 num">Futures: date,open,high,low,close,volume · Options: date,symbol,strike,otype,expiry,open,high,low,close,volume</div>
          </label>
          {loadPct !== null && <div className="prog mt-2"><div style={{ width: `${loadPct}%` }} /></div>}
          {alert && <div className="alert-err mt-2" role="alert"><span>⚠</span><span>{alert}</span></div>}
          <DatasetChips />
          <DataHealth />
        </section>

        {/* tiles */}
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4">
          <TileCard
            icon="🔬"
            title="Option Discovery"
            subtitle="Option-native research (no futures signals)"
            description="Independent discovery pipeline: dynamic chain detection, event/relationship/lead-lag mining, chronological OOS, robustness 0–10, paper gate."
            stats={[
              { label: 'Input', value: 'Options only' },
              { label: 'OOS', value: 'Strict' },
              { label: 'Paper', value: 'Gated' },
            ]}
            ready={true}
            status="Independent research tab — loads exported discovery bundles"
            onClick={() => navigate('#/discovery')}
          />
          <TileCard
            icon="📈"
            title="Futures Terminal"
            subtitle="Nifty / BankNifty / Stock Futures"
            description="Multi-symbol grid search with regime routing, walk-forward validation, robustness scoring (0–10), and paper-trading gate."
            stats={[
              { label: 'Indicators', value: '30+' },
              { label: 'Timeframes', value: '1–15m' },
              { label: 'Objectives', value: '5' },
            ]}
            ready={futNames.length > 0}
            status={futNames.length
              ? `${futNames.length} symbol${futNames.length > 1 ? 's' : ''} · ${enabledOf(futNames).length} enabled · ${fmtBars(barsOf(enabledOf(futNames)))} bars`
              : 'No futures data yet — upload a CSV above'}
            onClick={() => goTo('futures')}
          />
          <TileCard
            icon="🎯"
            title="Buy Only"
            subtitle="Option Buy-Only Backtester"
            description="Four hypotheses (volatility coil, OI velocity, liquidity flush, VWAP snap-back), adaptive Trending/Compressing/Choppy regime engine with a 2-loss shutdown, structure-stop → breakeven → 50% lock → 1-candle trail. ATM/ITM only."
            stats={[
              { label: 'Side', value: 'Long only' },
              { label: 'Universe', value: 'ATM/ITM' },
              { label: 'Exit', value: '4-stage' },
            ]}
            ready={optNames.length > 0}
            status={optNames.length
              ? `runs the Python engine server-side · ${optNames.length} contracts loaded`
              : 'No options data yet — upload a CSV above'}
            onClick={() => navigate('#/buyonly')}
          />
          <TileCard
            icon="⚡"
            title="Options Lab"
            subtitle="Nifty / BankNifty Index Options"
            description="Per-contract backtesting with ATM auto-select, expiry-day exclusion, premium floor, and ATM±1 bake-off. Buy-only."
            stats={[
              { label: 'Contracts', value: optNames.length ? String(optNames.length) : '42/exp' },
              { label: 'Mode', value: 'Buy-only' },
              { label: 'Exit', value: 'CK/ATR/BE' },
            ]}
            ready={optNames.length > 0}
            status={optNames.length
              ? `${optNames.length} contracts · ${enabledOf(optNames).length} enabled · ${fmtBars(barsOf(enabledOf(optNames)))} bars`
              : 'No options data yet — upload a CSV above'}
            onClick={() => goTo('options')}
          />
        </div>

        <footer className="text-center text-[11px] text-zinc-600 pb-6">
          <div className="num">
            v{BUILD_INFO.version} · commit {BUILD_INFO.commit} · updated{' '}
            {new Date(BUILD_INFO.builtAt).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
              hour: '2-digit', minute: '2-digit', hour12: false,
            })} IST
          </div>
          <div className="mt-1">XBOST terminal · real 1-min OHLCV → grid search · For research, not investment advice.</div>
        </footer>
      </main>
    </div>
  );
}

function DataHealth() {
  const datasets = useStore(s => s.datasets);
  const names = Object.keys(datasets);
  if (!names.length) return null;
  const h = dataHealth();
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {h.verdicts.map((v, i) => (
        <span key={i} title={v.detail}
          className={`text-[10px] num px-2 py-0.5 rounded-full border ${v.ok ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40' : 'text-red-300 border-red-900 bg-red-950/30'}`}>
          {v.ok ? '●' : '○'} {v.label} · {v.detail}
        </span>
      ))}
    </div>
  );
}

function DatasetChips() {
  const datasets = useStore(s => s.datasets);
  const set = useStore(s => s.set);
  const [expanded, setExpanded] = useState(false);
  const names = Object.keys(datasets);
  if (!names.length) return <div className="text-[11px] text-zinc-600 mt-2">No datasets loaded — tiles unlock as soon as a file parses.</div>;
  const toggle = (k: string) => {
    set({ datasets: { ...datasets, [k]: { ...datasets[k], enabled: datasets[k].enabled === false } } });
  };
  const remove = (k: string) => {
    const ds = { ...datasets };
    delete ds[k];
    set({ datasets: ds });
  };
  const shown = expanded ? names : names.slice(0, 9);
  const hidden = names.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {shown.map(k => {
        const n = datasets[k].raw.t.length;
        const on = datasets[k].enabled !== false;
        const isOpt = isOptionsDataset(k, datasets[k].label);
        return (
          <span key={k} className="flex items-center gap-1.5 text-[11px] bg-[#15151b] border border-[#2e2e36] rounded-md px-2 py-1">
            <input type="checkbox" checked={on} onChange={() => toggle(k)} title="Include in runs" />
            <span className={`text-[9px] font-bold px-1 rounded border ${isOpt ? 'text-amber-300 border-amber-700' : 'text-emerald-300 border-emerald-800'}`}>
              {isOpt ? 'OPT' : 'FUT'}
            </span>
            <span className="num font-semibold text-zinc-200">{k}</span>
            <span className="text-zinc-500 num">{fmtBars(n)}</span>
            <button className="text-zinc-500 hover:text-red-400" onClick={() => remove(k)} title="Remove">✕</button>
          </span>
        );
      })}
      {hidden > 0 && (
        <button className="btn-ghost btn-xs" onClick={() => setExpanded(true)}>
          +{hidden} more…
        </button>
      )}
      {expanded && names.length > 9 && (
        <button className="btn-ghost btn-xs" onClick={() => setExpanded(false)}>
          show less ▲
        </button>
      )}
    </div>
  );
}

function TileCard({
  icon, title, subtitle, description, stats, ready, status, onClick,
}: {
  icon: string;
  title: string;
  subtitle: string;
  description: string;
  stats: { label: string; value: string }[];
  ready: boolean;
  status: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="card relative p-6 text-left transition-all duration-300 cursor-pointer border-emerald-500/20 hover:border-emerald-400 hover:shadow-[0_0_24px_rgba(16,185,129,0.12)]"
      style={{ borderWidth: '1px' }}
    >
      <div className="absolute top-4 right-4 text-3xl select-none opacity-80">{icon}</div>

      <div className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full border mb-3 ${ready ? 'text-emerald-300 border-emerald-800 bg-emerald-950/40' : 'text-zinc-400 border-zinc-700 bg-zinc-900/60'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
        {ready ? 'READY' : 'NO DATA'}
      </div>

      <h2 className="font-display font-semibold text-[20px] tracking-tight text-white">{title}</h2>
      <p className="text-zinc-400 text-sm mt-0.5">{subtitle}</p>

      <p className="text-zinc-500 text-[13px] leading-relaxed mt-3 mb-5">{description}</p>

      <div className="grid grid-cols-3 gap-2.5 mb-5">
        {stats.map((s, i) => (
          <div key={i} className="bg-[#111] border border-zinc-800 rounded-lg p-2.5 text-center">
            <div className="font-display font-bold text-[17px] text-emerald-400 num">{s.value}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="pt-3 border-t border-zinc-800">
        <div className="text-[11px] text-zinc-500 num mb-1.5">{status}</div>
        <div className="text-[13px] font-semibold text-emerald-400">Enter {title} →</div>
      </div>
    </button>
  );
}