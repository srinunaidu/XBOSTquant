import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { logout } from '../lib/api';
import { runGrid, stopRun } from '../lib/runner';
import { exportBoard, exportTrades } from '../lib/export';

function useHashRoute() {
  const [r, setR] = useState(() => location.hash.replace(/^#\/?/, ''));
  useEffect(() => {
    const onHash = () => setR(location.hash.replace(/^#\/?/, ''));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return r;
}

export default function Header() {
  const user = useStore(s => s.user);
  const data = useStore(s => s.data);
  const symbol = useStore(s => s.symbol);
  const running = useStore(s => s.run.running);
  const alert = useStore(s => s.alert);
  const instrumentMode = useStore(s => s.instrumentMode);
  const route = useHashRoute();
  const onHome = route === '' || route === 'login';

  return (
    <header className="sticky top-0 z-40 border-b border-[#232329] bg-[#07070c]/90 backdrop-blur px-4 py-2.5 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-zinc-950 text-lg font-display logo-grad">X</div>
        <div>
          <div className="font-display font-bold tracking-tight text-[16px] grad-text">XBOST // QUANT TERMINAL</div>
          <div className="text-[10px] text-zinc-500 tracking-[.18em] uppercase">Nifty · BankNifty · Equities · 1-min OHLCV Engine</div>
        </div>
      </div>
      <div className="flex items-center gap-2 ml-auto text-xs">
        {instrumentMode && (
          <a href="#/" className="btn-ghost btn-xs no-underline" title="Back to home">
            ⌂ Home{instrumentMode === 'futures' ? ' · Futures' : ' · Options'}
          </a>
        )}
        <span className={`badge num ${data ? 'badge-live' : ''}`}>
          <span className="pulse" />
          <span>{data ? `${symbol || 'UNNAMED'} · ${(data.t.length / 1000).toFixed(0)}k bars` : 'no data — upload 1-min CSV'}</span>
        </span>
        <button className="btn-ghost btn-xs" onClick={() => exportTrades()}>⬇ Trades CSV</button>
        <button className="btn-ghost btn-xs" onClick={() => exportBoard()}>⬇ Board CSV</button>
        {!onHome && (!running
          ? <button className="btn-run" onClick={() => runGrid()}>▶ RUN GRID SEARCH</button>
          : <button className="btn-ghost btn-xs" onClick={() => stopRun()}>■ STOP</button>)}
        {user && (
          <span className="flex items-center gap-2">
            <span className="badge num">👤 {user.username}{user.role === 'admin' ? ' · admin' : ''}</span>
            {user.role === 'admin' && <a href="#/users" className="btn-ghost btn-xs no-underline">👥 Users</a>}
            <button className="btn-ghost btn-xs" onClick={async () => { await logout(); location.hash = '#/login'; location.reload(); }}>⏻ Logout</button>
          </span>
        )}
      </div>
      {alert && (
        <div className="alert-err w-full" role="alert">
          <span>⚠</span><span>{alert}</span>
          <button className="ml-auto underline" onClick={() => useStore.getState().set({ alert: null })}>dismiss</button>
        </div>
      )}
    </header>
  );
}

