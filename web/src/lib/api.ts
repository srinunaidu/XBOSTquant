// Auth API wrappers (same Express endpoints as the classic terminal).
export type User = { id: number; username: string; role: string; active?: boolean; created_at?: string };

export async function me(): Promise<User | null> {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return null;
    const j = await r.json();
    return j.user ?? null;
  } catch {
    return null;
  }
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string; user?: User }> {
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, user: j.user } : { ok: false, error: j.error || `HTTP ${r.status}` };
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export async function listUsers(): Promise<User[]> {
  const r = await fetch('/api/users');
  if (!r.ok) throw new Error('forbidden');
  return (await r.json()).users ?? [];
}

export async function createUser(username: string, password: string, role: string): Promise<void> {
  const r = await fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
}

export async function patchUser(id: number, body: Record<string, unknown>): Promise<void> {
  const r = await fetch(`/api/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
}
