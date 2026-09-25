import React from 'react';

// Catches render-path crashes (charts/grids on huge details) and turns a dead
// tab into a readable panel with diagnostics instead of Aw Snap/white screen.
// Note: true browser OOM kills can't be caught — the memory readout in the dev
// panel + run log helps diagnose those instead.
type Props = { children: React.ReactNode; name: string };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    try {
      const mem = (performance as any)?.memory?.usedJSHeapSize
        ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) + 'MB heap'
        : 'heap n/a';
      console.error(`[xbost] ${this.props.name} crashed:`, error, mem);
    } catch { /* noop */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const mem = (performance as any)?.memory?.usedJSHeapSize
      ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) + ' MB JS heap'
      : 'heap info unavailable';
    return (
      <section className="card p-4 m-3" style={{ borderColor: '#7c2d12' }}>
        <div className="font-display font-semibold text-[15px] text-red-300">
          ⚠ {this.props.name} failed to render
        </div>
        <pre className="text-[11px] num text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-md p-2 mt-2 whitespace-pre-wrap max-h-40 overflow-auto">
          {String(this.state.error?.message || this.state.error).slice(0, 800)}
        </pre>
        <div className="text-[11px] text-zinc-500 mt-2 num">
          {mem} · Your run results are safe (leaderboard + log below are unaffected).
          Screenshot this + note what you clicked, then reload.
        </div>
        <div className="flex gap-2 mt-3">
          <button
            className="btn-ghost btn-xs"
            onClick={() => this.setState({ error: null })}>
            ↻ Retry render
          </button>
          <button
            className="btn-ghost btn-xs"
            onClick={() => location.reload()}>
            ⟳ Reload terminal
          </button>
        </div>
      </section>
    );
  }
}
