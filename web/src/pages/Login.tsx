import { useState } from 'react';
import { login } from '../lib/api';
import { useStore } from '../lib/store';

export default function Login() {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const set = useStore(s => s.set);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const r = await login(u, p);
    if (r.ok && r.user) {
      set({ user: r.user });
      location.hash = '#/';
    } else setErr(r.error || 'Login failed');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card p-8 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-1">
          <div className="logo-grad w-11 h-11 rounded-xl flex items-center justify-center font-black text-zinc-950 text-xl font-display">X</div>
          <div>
            <div className="font-display font-bold tracking-tight text-[17px] grad-text">XBOST // QUANT TERMINAL</div>
            <div className="text-[10px] text-zinc-500 tracking-[.18em] uppercase">Restricted · login required</div>
          </div>
        </div>
        <form className="space-y-3 mt-6" onSubmit={submit}>
          <div><label className="text-[11px] uppercase tracking-widest text-zinc-400">Username</label>
            <input value={u} onChange={e => setU(e.target.value)} autoComplete="username" className="mt-1 w-full !py-2.5" /></div>
          <div><label className="text-[11px] uppercase tracking-widest text-zinc-400">Password</label>
            <input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" className="mt-1 w-full !py-2.5" /></div>
          {err && <div className="alert-err"><span>⚠</span><span>{err}</span></div>}
          <button className="btn-run w-full !py-2.5" type="submit">Sign in →</button>
        </form>
        <div className="text-[11px] text-zinc-600 mt-4 text-center">Contact your admin for an account.</div>
      </div>
    </div>
  );
}
