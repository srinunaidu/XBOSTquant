// Client crash reporter: window errors + unhandled rejections are beaconed to
// POST /api/client-error so the SERVER log (Railway dashboard → View Logs)
// keeps evidence even when the tab dies seconds later. Includes run context +
// heap + mirrored-log tail. Throttled client-side (max 5/session) and
// server-side (20/min/IP). No PII, no strategy secrets — errors only.
let sent = 0;

function payload(message: string, stack?: string) {
  let run = '', board = '', heap = '', tail = '';
  try {
    const S = (window as any).__XBOST__?.getState?.();
    if (S) {
      run = `${S.runId || ''} ${S.run?.stage || ''} ${S.run?.done ?? ''}/${S.run?.total ?? ''}`;
      board = String(S.board?.length ?? '');
    }
  } catch { /* noop */ }
  try {
    const m = (performance as any)?.memory?.usedJSHeapSize;
    if (m) heap = Math.round(m / 1048576) + 'MB';
  } catch { /* noop */ }
  try {
    const lines = JSON.parse(localStorage.getItem('xbost_log_v1') || '[]');
    if (Array.isArray(lines)) tail = lines.slice(-8).join(' § ').slice(0, 900);
  } catch { /* noop */ }
  return { message: String(message).slice(0, 500), stack: String(stack || '').slice(0, 800), url: location.href.slice(0, 200), run, heap, board, tail };
}

function send(payloadObj: ReturnType<typeof payload>) {
  if (sent >= 5) return;
  sent++;
  try {
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadObj),
      keepalive: true,
    }).catch(() => { /* tab may be dying — best effort */ });
  } catch { /* noop */ }
}

export function installCrashReporter() {
  if ((window as any).__xbost_reporter) return;
  (window as any).__xbost_reporter = true;
  window.addEventListener('error', (e) => {
    send(payload(e.message || 'window.onerror', (e.error && e.error.stack) || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send(payload('unhandledrejection: ' + (r?.message || String(r)).slice(0, 200), r?.stack || ''));
  });
}
