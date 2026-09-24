import { useState } from 'react';
import Header from '../components/Header';
import { useStore } from '../lib/store';
import { useNavigate } from '../lib/router';
import { loadFile } from '../lib/data';
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
        </section>

        {/* tiles */}
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-4">
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