export function fmtMoney(v: number): string {
  const s = v < 0 ? '-₹' : '₹';
  return s + Math.abs(Math.round(v)).toLocaleString('en-IN');
}
export function fmtParams(p?: Record<string, number>): string {
  if (!p) return '—';
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ') || '—';
}
export function fmtT(t: number): string {
  return new Date(t).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
// IST wall-clock for exports (data is IST; toISOString would print UTC)
export function fmtIST(t: number): string {
  return new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 19) + '+05:30';
}
export function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
