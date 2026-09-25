import { useEffect, useState } from 'react';
import { useStore } from './lib/store';
import { me } from './lib/api';
import { installCrashReporter } from './lib/reporter';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import MainView from './components/MainView';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './pages/Login';
import Users from './pages/Users';
import Home from './pages/Home';

function route() {
  return location.hash.replace(/^#\/?/, '');
}

export default function App() {
  const user = useStore(s => s.user);
  const set = useStore(s => s.set);
  const sbHide = useStore(s => s.sbHide);
  const [r, setR] = useState(route());
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    installCrashReporter();
    const onHash = () => setR(route());
    window.addEventListener('hashchange', onHash);
    me().then(u => {
      set({ user: u });
      if (!u && route() !== 'login' && route() !== 'users') location.hash = '#/login';
      setBooted(true);
    });
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!booted) return <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">Connecting…</div>;
  if (!user) return <Login />;
  if (r === 'users') {
    if (user.role !== 'admin') return <Login />;
    return <Users />;
  }

  const isTerminal = r === 'futures' || r === 'options';
  if (isTerminal) {
    set({ instrumentMode: r });
  }

  const toggleSb = () => {
    const hide = !useStore.getState().sbHide;
    set({ sbHide: hide });
    try { localStorage.setItem('xbost_sb', hide ? 'hide' : 'show'); } catch { /* noop */ }
  };

  if (!isTerminal) {
    return <Home />;
  }

  return (
    <div className={`min-h-screen${sbHide ? ' sb-hide-w' : ''}`}>
      <Header />
      <div className="flex flex-col lg:flex-row relative">
        <button
          onClick={toggleSb} title="Toggle configuration panel" aria-label="Toggle configuration panel"
          className="hidden lg:flex absolute items-center justify-center z-30 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-all duration-300"
          style={{
            left: sbHide ? -7 : 318, top: 66, width: 26, height: 52,
            borderRadius: 8, background: '#15151b', border: '1px solid #2e2e36',
          }}>
          <span style={{ display: 'inline-block', transform: sbHide ? 'rotate(180deg)' : 'none', transition: 'transform .3s' }}>❮</span>
        </button>
        <button onClick={toggleSb} className="lg:hidden btn-ghost btn-xs m-2">
          {sbHide ? 'Show configuration ▲' : 'Hide configuration ▼'}
        </button>
        <aside className="sb-aside w-full lg:w-[330px] shrink-0 lg:h-[calc(100vh-57px)] lg:sticky lg:top-[57px] lg:overflow-y-auto border-r border-[#232329] p-3">
          <Sidebar />
        </aside>
        <ErrorBoundary name="Terminal workspace">
          <MainView />
        </ErrorBoundary>
      </div>
    </div>
  );
}