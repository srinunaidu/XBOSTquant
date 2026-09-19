import { useEffect, useState } from 'react';
import { createUser, listUsers, patchUser, type User } from '../lib/api';

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [nu, setNu] = useState('');
  const [np, setNp] = useState('');
  const [nr, setNr] = useState('user');
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);

  const refresh = async () => {
    try { setUsers(await listUsers()); }
    catch { location.hash = '#/login'; }
  };
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    try {
      await createUser(nu, np, nr);
      setMsg({ t: `User ${nu} created.`, ok: true });
      setNu(''); setNp('');
      refresh();
    } catch (e: any) { setMsg({ t: e?.message || 'Failed.', ok: false }); }
  };

  const toggle = async (u: User) => {
    await patchUser(u.id, { active: !u.active });
    refresh();
  };

  const resetPw = async (u: User) => {
    const p = prompt(`New password for ${u.username} (min 8 chars):`);
    if (!p) return;
    try { await patchUser(u.id, { password: p }); setMsg({ t: 'Password updated.', ok: true }); }
    catch (e: any) { setMsg({ t: e?.message || 'Failed.', ok: false }); }
    refresh();
  };

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <a href="#/" className="btn-ghost btn-xs no-underline">← Terminal</a>
        <h1 className="font-display font-bold text-lg tracking-tight">👥 User Management <span className="text-xs text-zinc-500 font-normal">admin only</span></h1>
      </div>
      <div className="card p-4 mb-4">
        <div className="font-bold text-sm mb-2">＋ Add user</div>
        <div className="flex flex-wrap gap-2">
          <input value={nu} onChange={e => setNu(e.target.value)} placeholder="username (3-32)" className="flex-1 min-w-[140px]" />
          <input type="password" value={np} onChange={e => setNp(e.target.value)} placeholder="password (min 8)" className="flex-1 min-w-[140px]" />
          <select value={nr} onChange={e => setNr(e.target.value)}>
            <option value="user">user</option><option value="admin">admin</option>
          </select>
          <button className="btn-run" onClick={add}>Create</button>
        </div>
        <div className="text-xs mt-2 h-4" style={{ color: msg?.ok ? '#22ff88' : '#ff3b5c' }}>{msg?.t || ''}</div>
      </div>
      <div className="card p-4">
        <div className="font-bold text-sm mb-2">Accounts</div>
        <table className="w-full">
          <thead><tr className="text-[10px] uppercase tracking-wider text-zinc-400">
            <th className="p-2 text-left">ID</th><th className="p-2 text-left">Username</th><th className="p-2 text-left">Role</th>
            <th className="p-2 text-left">Status</th><th className="p-2 text-left">Created</th><th></th>
          </tr></thead>
          <tbody className="num">
            {users.map(u => (
              <tr key={u.id} className="border-t border-[#1b1b22]">
                <td className="p-2">{u.id}</td><td className="p-2">{u.username}</td><td className="p-2">{u.role}</td>
                <td className="p-2">{u.active ? <span className="pos">active</span> : <span className="neg">disabled</span>}</td>
                <td className="p-2">{u.created_at}</td>
                <td className="p-2 flex gap-2">
                  <button className="btn-ghost btn-xs" onClick={() => toggle(u)}>{u.active ? 'Disable' : 'Enable'}</button>
                  <button className="btn-ghost btn-xs" onClick={() => resetPw(u)}>Reset pw</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
