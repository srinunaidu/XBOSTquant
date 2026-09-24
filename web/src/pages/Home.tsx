import { useNavigate } from '../lib/router';
import { useStore } from '../lib/store';

export default function Home() {
  const navigate = useNavigate();
  const user = useStore(s => s.user);
  const datasets = useStore(s => s.datasets);

  const hasFutures = Object.keys(datasets).some(k => 
    !k.toUpperCase().includes('OPTION') && 
    !k.toUpperCase().includes('CE') && 
    !k.toUpperCase().includes('PE')
  );
  const hasOptions = Object.keys(datasets).some(k => 
    k.toUpperCase().includes('OPTION') || 
    k.toUpperCase().includes('CE') || 
    k.toUpperCase().includes('PE')
  );

  const goTo = (mode: 'futures' | 'options') => {
    navigate(`#/${mode}`);
    useStore.getState().set({ instrumentMode: mode });
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-[#0d0d12]">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-4">
        <TileCard
          icon="📈"
          title="Futures Terminal"
          subtitle="Nifty / BankNifty / Stock Futures"
          description="Multi-symbol grid search with regime routing, walk-forward validation, robustness scoring (0-10), and paper-trading gate."
          stats={[
            { label: 'Indicators', value: '30+' },
            { label: 'Timeframes', value: '1–15m' },
            { label: 'Objectives', value: '5' },
          ]}
          enabled={hasFutures}
          onClick={() => goTo('futures')}
        />
        <TileCard
          icon="⚡"
          title="Options Lab"
          subtitle="Nifty / BankNifty Index Options"
          description="Per-contract backtesting with ATM auto-select, expiry-day exclusion, premium floor, and ATM±1 bake-off."
          stats={[
            { label: 'Contracts', value: '42/exp' },
            { label: 'Mode', value: 'Buy-only' },
            { label: 'Exit', value: 'CK/ATR/BE' },
          ]}
          enabled={hasOptions}
          onClick={() => goTo('options')}
        />
      </div>
      
      {!hasFutures && !hasOptions && (
        <div className="mt-8 text-center text-zinc-500">
          <p className="text-sm mb-2">No data loaded. Upload CSV files from the sidebar to begin.</p>
          <p className="text-xs">Futures: date,open,high,low,close,volume</p>
          <p className="text-xs">Options: date,symbol,strike,otype,expiry,open,high,low,close,volume</p>
        </div>
      )}

      <footer className="fixed bottom-4 left-0 right-0 text-center text-[11px] text-zinc-600">
        XBOST terminal · {user?.username || 'guest'} · real 1-min OHLCV → grid search · For research, not investment advice.
      </footer>
    </main>
  );
}

function TileCard({ 
  icon, title, subtitle, description, stats, enabled, onClick 
}: { 
  icon: string; 
  title: string; 
  subtitle: string; 
  description: string; 
  stats: { label: string; value: string }[]; 
  enabled: boolean; 
  onClick: () => void; 
}) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      className={`card relative p-6 h-full transition-all duration-300 cursor-pointer 
        ${enabled 
          ? 'border-emerald-500/30 hover:border-emerald-400 hover:bg-[#15151b] hover:shadow-[0_0_20px_rgba(16,185,129,0.1)]' 
          : 'border-zinc-800 opacity-60 cursor-not-allowed'
        }`}
      style={{ borderWidth: '1px' }}
    >
      <div className="absolute top-3 right-3 text-4xl select-none">{icon}</div>
      
      <div className="mb-4">
        <h2 className="font-display font-semibold text-[20px] tracking-tight text-white">{title}</h2>
        <p className="text-zinc-400 text-sm mt-1">{subtitle}</p>
      </div>

      <p className="text-zinc-500 text-[13px] leading-relaxed mb-6">{description}</p>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {stats.map((s, i) => (
          <div key={i} className="bg-[#111] border border-zinc-800 rounded-lg p-3 text-center">
            <div className="font-display font-bold text-[18px] text-emerald-400">{s.value}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-zinc-800">
        <span className={`text-xs font-medium ${enabled ? 'text-emerald-400' : 'text-zinc-600'}`}>
          {enabled ? 'Enter Terminal →' : 'No data loaded'}
        </span>
        <span className="text-zinc-500 text-xs">
          {enabled ? 'Configure → Run → Review' : 'Upload CSV in sidebar'}
        </span>
      </div>

      {!enabled && (
        <div className="absolute inset-0 bg-black/50 rounded-md flex items-center justify-center pointer-events-none">
          <span className="bg-zinc-900/90 border border-zinc-700 px-3 py-1 rounded text-xs text-zinc-400">
            Load data first
          </span>
        </div>
      )}
    </button>
  );
}