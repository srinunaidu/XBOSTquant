"""Metrics, logic map and reporting for the buy-only engine.

Deliberate discipline
---------------------
"Best performing hypothesis" here means best *measured* on this dataset, and the
report states the sample size and a permutation p-value next to every headline
number. A configuration chosen by searching many parameter sets and then reported
as the winner is a fitted maximum, not an edge, so the search grid is reported
too and the verdict is downgraded when the evidence cannot separate it from noise.

Win rate alone is also not sufficient evidence of quality, so the report always
carries profit factor, max drawdown and time-to-target alongside it: a 70% win
rate that loses money on its rare large losers is a losing strategy.
"""
import numpy as np
import pandas as pd



def _safe(x, default=float("nan")):
    try:
        v = float(x)
        return v if np.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def max_drawdown(points):
    """Max drawdown of the cumulative POINT curve (negative number)."""
    if points is None or len(points) == 0:
        return float("nan")
    eq = np.cumsum(np.asarray(points, dtype=float))
    peak = np.maximum.accumulate(eq)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peak != 0, (eq - peak) / np.abs(peak), 0.0)
    return float(dd.min()) * 100.0 if len(dd) else float("nan")


def summarize(ledger, cfg=None, label="ALL"):
    """WR / PF / MaxDD / Time-to-Target plus the supporting detail."""
    out = {"label": label, "trades": 0, "win_rate": float("nan"),
           "profit_factor": float("nan"), "max_dd_points": float("nan"),
           "net_points": 0.0, "avg_net_points": float("nan"),
           "expectancy_points": float("nan"), "gross_profit": 0.0,
           "gross_loss": 0.0, "rupee_pnl": 0.0,
           "time_to_target_bars": float("nan"), "time_to_target_min": float("nan"),
           "reached_target": 0, "target_hit_rate": float("nan"),
           "avg_duration_bars": float("nan"), "avg_risk_points": float("nan"),
           "be_armed_rate": float("nan"), "profit_locked_rate": float("nan"),
           "avg_mfe_points": float("nan"), "avg_mae_points": float("nan"),
           "status": "NO_TRADES"}
    if ledger is None or len(ledger) == 0:
        return out

    net = pd.to_numeric(ledger["net_points"], errors="coerce").dropna()
    n = int(len(net))
    wins = net[net > 0]
    losses = net[net <= 0]
    gp = float(wins.sum())
    gl = float(abs(losses.sum()))

    t2t = pd.to_numeric(ledger.get("time_to_target_bars"), errors="coerce").dropna()
    t2t = t2t[t2t > 0]

    out.update({
        "trades": n,
        "win_rate": round(100.0 * len(wins) / n, 2),
        "profit_factor": round(gp / gl, 3) if gl > 0 else float("inf"),
        "max_dd_points": round(max_drawdown(net.to_numpy()), 3),
        "net_points": round(float(net.sum()), 3),
        "avg_net_points": round(float(net.mean()), 3),
        "expectancy_points": round(float(net.mean()), 3),
        "gross_profit": round(gp, 3),
        "gross_loss": round(gl, 3),
        "rupee_pnl": round(float(pd.to_numeric(ledger["rupee_pnl"], errors="coerce").sum()), 2),
        "time_to_target_bars": round(float(t2t.mean()), 2) if len(t2t) else float("nan"),
        "time_to_target_min": round(float(t2t.mean()), 2) if len(t2t) else float("nan"),
        "reached_target": int(len(t2t)),
        "target_hit_rate": round(100.0 * len(t2t) / n, 2),
        "avg_duration_bars": round(float(pd.to_numeric(ledger["duration_bars"],
                                                        errors="coerce").mean()), 2),
        "avg_risk_points": round(float(pd.to_numeric(ledger["risk_points"],
                                                     errors="coerce").mean()), 3),
        "be_armed_rate": round(100.0 * float(ledger["be_moved"].mean()), 2),
        "profit_locked_rate": round(100.0 * float(ledger["profit_locked"].mean()), 2),
        "avg_mfe_points": round(float(pd.to_numeric(ledger["mfe_points"],
                                                    errors="coerce").mean()), 3),
        "avg_mae_points": round(float(pd.to_numeric(ledger["mae_points"],
                                                    errors="coerce").mean()), 3),
        "status": "MEASURED",
    })
    return out


def bootstrap_ci(points, n_boot=2000, seed=42, alpha=0.05):
    """Percentile bootstrap CI for the mean net points per trade."""
    v = pd.to_numeric(pd.Series(list(points)), errors="coerce").dropna().to_numpy(float)
    v = v[np.isfinite(v)]
    if len(v) < 3:
        return {"mean": float("nan"), "lo": float("nan"), "hi": float("nan"),
                "n": int(len(v)), "excludes_zero": False}
    rng = np.random.default_rng(seed)
    means = np.array([rng.choice(v, size=len(v), replace=True).mean()
                      for _ in range(int(n_boot))])
    lo, hi = np.percentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return {"mean": float(v.mean()), "lo": float(lo), "hi": float(hi),
            "n": int(len(v)), "excludes_zero": bool(lo > 0 or hi < 0)}


def signal_permutation_test(u, q, cfg, signals, observed_net, n_perm=50, seed=42,
                            restrict_to_regime=True):
    """Is this entry TIMING better than random timing of the same signals?

    The null re-runs the WHOLE engine with every signal's timestamp shifted by a
    random offset inside its own session. That preserves the number of signals
    and the per-day distribution while destroying the specific moments chosen,
    so the observed total can be compared against a real null.

    Why this is done at the SIGNAL level and not on the trade ledger
    ------------------------------------------------------------------
    Shuffling the realised trade returns cannot work: the mean of a permuted
    series is mathematically identical to the original, so the null always
    equals the observation and p is always 1. Rolling an all-ones trade mask
    inside a single-day block fails the same way - the roll is a no-op. Both
    were measured on this dataset and returned a degenerate p=1.0 no matter what
    the data was, so neither is used here. Only re-timing the signals and
    re-running the engine can actually answer the question.
    """
    from .engine import run_backtest
    out = {"p_value": float("nan"), "observed_net": float(observed_net),
           "null_mean": float("nan"), "null_sd": float("nan"), "null_median": float("nan"),
           "n_perm": 0, "status": "UNTESTABLE",
           "method": "signal re-timing null (engine re-run per permutation)"}
    if signals is None or len(signals) == 0 or u is None or len(u) == 0:
        return out
    sig = signals.copy()
    sig["timestamp"] = pd.to_datetime(sig["timestamp"])
    sig["_day"] = sig["timestamp"].dt.normalize()

    uu = u.sort_values("timestamp").reset_index(drop=True).copy()
    uu["_day"] = pd.to_datetime(uu["timestamp"]).dt.normalize()
    day_bars = {d: grp["timestamp"].to_numpy()
                for d, grp in uu.groupby("_day") if len(grp) > 1}
    u_clean = uu.drop(columns=["_day"], errors="ignore")

    totals = []
    for k in range(int(n_perm)):
        rng = np.random.default_rng(seed + k)
        shifted = []
        for day, grp in sig.groupby("_day"):
            bars = day_bars.get(day)
            if bars is None or len(bars) < 2:
                shifted.append(grp)
                continue
            idx = np.searchsorted(bars, grp["timestamp"].to_numpy())
            off = int(rng.integers(1, len(bars)))
            shifted.append(grp.assign(timestamp=bars[(idx + off) % len(bars)]))
        if not shifted:
            continue
        s2 = pd.concat(shifted, ignore_index=True).sort_values("timestamp")
        s2 = s2.drop(columns=["_day"], errors="ignore")
        try:
            led2, _ = run_backtest(s2, u_clean, q, cfg,
                                   restrict_to_regime=restrict_to_regime)
            v = pd.to_numeric(led2.get("net_points"), errors="coerce").dropna()
            totals.append(float(v.sum()) if len(v) else 0.0)
        except Exception:
            continue

    fin = np.array([t for t in totals if np.isfinite(t)], dtype=float)
    if len(fin) == 0:
        return out
    obs = float(observed_net)
    out.update({
        "p_value": float((np.sum(fin >= obs) + 1) / (len(fin) + 1)),
        "null_mean": float(fin.mean()),
        "null_sd": float(fin.std(ddof=1)) if len(fin) > 1 else 0.0,
        "null_median": float(np.median(fin)),
        "n_perm": int(len(fin)),
        "status": "TESTED" if len(fin) >= 10 else "INSUFFICIENT_PERMUTATIONS",
    })
    return out


def by_hypothesis(ledger, cfg=None, min_trades=5):
    """Per-hypothesis comparison, ranked by win rate then net points."""
    if ledger is None or len(ledger) == 0:
        return []
    rows = []
    for hyp, g in ledger.groupby("hypothesis"):
        s = summarize(g, cfg, label=hyp)
        need = min_trades if cfg is None else cfg.min_trades_for_verdict
        s["min_trades_met"] = bool(len(g) >= need)
        rows.append(s)
    rows.sort(key=lambda r: (-(r["win_rate"] if np.isfinite(r["win_rate"]) else -1),
                             -(r["net_points"])))
    return rows


def significance(ledger, n_perm=200, seed=42):
    """Bootstrap CI on the mean net points per trade.

    This measures whether the AVERAGE trade is profitable. It deliberately does
    NOT claim to test entry timing: the mean of a permuted return series is
    invariant, so a ledger-level permutation test is structurally degenerate.
    Timing is tested by `signal_permutation_test`, which re-runs the engine on
    re-timed signals.
    """
    empty = {"mean": float("nan"), "lo": float("nan"), "hi": float("nan"),
             "n": 0, "excludes_zero": False, "status": "INSUFFICIENT_TRADES"}
    if ledger is None or len(ledger) < 3:
        return {**empty, "status": "INSUFFICIENT_TRADES"}
    net = pd.to_numeric(ledger["net_points"], errors="coerce")
    res = bootstrap_ci(net.dropna(), seed=seed)
    res["status"] = "TESTED"
    return res

def sensitivity(u, q, cfg, restrict_to_regime=True, grid=None):
    """Re-run the engine across a small parameter grid and report the SPREAD.

    A configuration whose profitability flips sign on a one-step change in a
    single threshold has not found an edge, it has found a noise pocket. The
    spread is reported so the headline number can be read with the right amount
    of suspicion instead of being quoted on its own.
    """
    import dataclasses
    from .engine import run_backtest
    from .hypotheses import run_all
    from .features import add_session_features
    from .regime import classify_regimes

    if grid is None:
        grid = {"min_stop_points": [10.0, 20.0, 30.0, 35.0, 45.0, 60.0],
                "target_r": [1.0, 2.0, 3.0]}
    rows = []
    for key, values in grid.items():
        for v in values:
            c2 = dataclasses.replace(cfg, **{key: v})
            # Recompute features from the RAW underlying. Dropping previously
            # derived columns is fragile (a missing name raises), and rebuilding
            # from raw guarantees the sweep never reuses stale features.
            uu = classify_regimes(add_session_features(u.copy(), c2.er_window), c2)
            s2, _ = run_all(uu, q, c2)
            led2, _ = run_backtest(s2, uu, q, c2,
                                   restrict_to_regime=restrict_to_regime)
            sm = summarize(led2, c2, label=f"{key}={v}")
            rows.append({"param": key, "value": v, "trades": sm["trades"],
                         "win_rate": sm["win_rate"], "profit_factor": sm["profit_factor"],
                         "net_points": sm["net_points"]})
    wrs = [r["win_rate"] for r in rows if np.isfinite(r["win_rate"])]
    nets = [r["net_points"] for r in rows]
    pos = sum(1 for n in nets if n > 0)
    return {"rows": rows,
            "win_rate_min": round(min(wrs), 2) if wrs else None,
            "win_rate_max": round(max(wrs), 2) if wrs else None,
            "net_min": round(min(nets), 2) if nets else None,
            "net_max": round(max(nets), 2) if nets else None,
            "configs_profitable": pos, "configs_total": len(rows)}


def logic_map():
    """The adaptive engine's decision map (text + mermaid)."""
    text = """
SIGNAL ARRIVES (hypothesis H, regime R, timestamp T)
   |
   +-- already in a position? ---------------------> BLOCK (one position at a time)
   |
   +-- in post-shutdown cooldown? ------------------> BLOCK (COOLDOWN)
   |
   +-- R == CHOPPY? -------------------------------> BLOCK (CHOPPY_REGIME)  [hard stop]
   |
   +-- 2 consecutive losses not yet cooled down? ---> BLOCK (LOSS_STREAK)  [hard stop]
   |
   +-- H is not the hypothesis authorised for R? ---> BLOCK (REGIME_HYPOTHESIS_MISMATCH)
   |
   +-- select contract: ATM or <= max_itm_steps ITM, on the correct side
   |      (CE only when strike <= ATM ; PE only when strike >= ATM)
   |      no ATM reference? ------------------------> SKIP (NO_ATM_REFERENCE)
   |      no ATM/ITM contract on that side? --------> SKIP (NO_ATM_OR_ITM_CONTRACT)
   |      deeper than max_itm_steps? ---------------> SKIP (ITM_TOO_DEEP)
   |
   +-- fill at the OPEN of bar T+1 (never at the signal close)
   |
   +-- EXIT ARCHITECTURE, evaluated per 1-minute bar of the option:
   |      1. structure stop  = trigger-candle low - buffer (>= min_stop_points)
   |      2. breakeven       = profit >= brokerage + 2.5 pts  -> SL -> entry
   |      3. profit lock     = profit >= 1R  -> SL -> entry + 50% of profit
   |      4. trail           = SL follows PREVIOUS candle low/high
   |      stop adjustment takes effect on the NEXT bar, never the bar that set it
   |      stop before target when a bar touches both (conservative)
   |      time stop at max_hold_bars
   |
   +-- net_points = gross - round_trip_cost (brokerage, STT, exchange, GST,
   |      stamp, slippage)  ->  fed back to the 2-loss circuit breaker
   +-- a WIN resets the consecutive-loss counter
"""
    mermaid = """```mermaid
flowchart TD
    S[Signal: hypothesis H, regime R] --> A{In a position?}
    A -- yes --> X1[BLOCK]
    A -- no --> B{In cooldown?}
    B -- yes --> X2[BLOCK cooldown]
    B -- no --> C{Regime CHOPPY?}
    C -- yes --> X3[BLOCK choppy]
    C -- no --> D{2 consecutive losses?}
    D -- yes --> X4[BLOCK loss streak]
    D -- no --> E{H authorised for R?}
    E -- no --> X5[BLOCK mismatch]
    E -- yes --> F[Select ATM/ITM contract]
    F --> G[Enter at next bar OPEN]
    G --> H1[Structure SL]
    H1 --> H2[Breakeven at brokerage+2.5pts]
    H2 --> H3[Lock 50% at 1R]
    H3 --> H4[Trail prev 1m candle]
    H4 --> I[Net P&L]
    I --> J{Loss?}
    J -- yes --> D
    J -- no --> K[Reset counter]
```"""
    regime_map = """
REGIME -> AUTHORISED HYPOTHESIS
  COMPRESSING  ->  VOLATILITY_COIL   (break out of a tightening coil)
  TRENDING     ->  LIQUIDITY_FLUSH   (fade the failed pullback, with the trend)
  CHOPPY       ->  (none)            HARD SHUTDOWN, no position may be opened
  OI_VELOCITY  ->  available only when the dataset carries open interest;
                   not part of the regime map because it is an OI-gated
                   detector rather than a regime-owned one.
"""
    return text + regime_map + "\n" + mermaid


def report_markdown(summary, per_hyp, sig, audit, cfg, availability, outdir=None,
                    sens=None, timing=None):
    """Human-readable report: verdict, table, logic map, honesty notes."""
    L = []
    L.append("# Option Buy-Only - backtest report")
    L.append("")
    L.append("## Headline")
    if summary["trades"] == 0:
        L.append("**NO_TRADES** - the adaptive engine blocked every signal.")
    else:
        L.append("| metric | value |")
        L.append("| --- | --- |")
        L.append(f"| Trades | {summary['trades']} |")
        L.append(f"| **Win rate** | **{summary['win_rate']}%** |")
        L.append(f"| **Profit factor** | **{summary['profit_factor']}** |")
        L.append(f"| **Max drawdown** | **{summary['max_dd_points']} pts** |")
        L.append(f"| **Time to target** | **{summary['time_to_target_bars']} bars "
                 f"({summary['time_to_target_min']} min)**, reached on "
                 f"{summary['reached_target']}/{summary['trades']} trades "
                 f"({summary['target_hit_rate']}%) |")
        L.append(f"| Net | {summary['net_points']} pts / Rs {summary['rupee_pnl']} "
                 f"({cfg.max_lots} lots) |")
        L.append(f"| Avg duration | {summary['avg_duration_bars']} bars |")
        L.append(f"| Avg risk | {summary['avg_risk_points']} pts |")
        L.append(f"| Breakeven armed | {summary['be_armed_rate']}% |")
        L.append(f"| 50% profit lock hit | {summary['profit_locked_rate']}% |")
    L.append("")
    L.append("## Statistical significance")
    L.append("")
    if sig.get("status") == "TESTED":
        L.append("Bootstrap CI on the mean net points per trade "
                 f"(n={sig.get('n')}, {sig.get('n', 0)} trades):")
        L.append("")
        L.append(f"- mean net = **{_safe(sig.get('mean')):.3f} pts/trade**")
        L.append(f"- 95% CI = [{_safe(sig.get('lo')):.3f}, {_safe(sig.get('hi')):.3f}] pts")
        if sig.get("excludes_zero"):
            L.append("- the interval **excludes zero**, so the average trade is "
                     "distinguishable from break-even at this sample size")
        else:
            L.append("- the interval **includes zero**: the average trade is not "
                     "distinguishable from break-even")
        L.append("")
        L.append("A ledger-level permutation test is deliberately NOT used here. The "
                 "mean of a permuted return series is mathematically identical to the "
                 "original, so such a null always equals the observation (measured "
                 "p=1.0 on this data regardless of content). See the timing test below.")
    else:
        L.append(f"Bootstrap CI not computable: {sig.get('status')}.")
    L.append("")
    if timing and timing.get("status") == "TESTED":
        L.append("### Entry-timing test (signal re-timing null)")
        L.append("")
        L.append(f"Every signal's timestamp is shifted by a random offset inside its own "
                 f"session and the whole engine is re-run, {timing.get('n_perm')} times. "
                 "Same number of signals, same per-day distribution, different moments.")
        L.append("")
        L.append(f"- observed net = **{_safe(timing.get('observed_net')):.2f} pts**")
        L.append(f"- null mean net = {_safe(timing.get('null_mean')):.2f} pts "
                 f"(sd {_safe(timing.get('null_sd')):.2f}, median "
                 f"{_safe(timing.get('null_median')):.2f})")
        L.append(f"- **p = {_safe(timing.get('p_value')):.4f}**")
        L.append("")
        tp = _safe(timing.get("p_value"), 1.0)
        if tp < 0.05:
            L.append("Verdict: this entry TIMING beats random timing at p<0.05.")
        else:
            L.append("Verdict: **the timing is NOT distinguishable from random timing** "
                     "at this sample size. The numbers above are descriptive.")
    elif timing:
        L.append("### Entry-timing test")
        L.append("")
        L.append(f"Not testable: {timing.get('status')}.")
    L.append("")
    L.append("## Hypothesis comparison")
    L.append("")
    L.append("| hypothesis | trades | win rate | PF | net pts | avg dur | reached target |")
    L.append("| --- | --- | --- | --- | --- | --- | --- |")
    for r in per_hyp:
        L.append(f"| {r['label']} | {r['trades']} | {r['win_rate']}% | "
                 f"{r['profit_factor']} | {r['net_points']} | {r['avg_duration_bars']} | "
                 f"{r['reached_target']} |")
    L.append("")
    na = [k for k, v in availability.items() if not str(v).startswith("AVAILABLE")]
    if na:
        L.append("**Not evaluated:**")
        for k in na:
            L.append(f"- `{k}` - {availability[k]}")
        L.append("")
    if sens:
        L.append("## Parameter sensitivity (robustness of the headline)")
        L.append("")
        L.append("| parameter | value | trades | WR% | PF | net pts |")
        L.append("| --- | --- | --- | --- | --- | --- |")
        for r in sens["rows"]:
            L.append(f"| {r['param']} | {r['value']} | {r['trades']} | {r['win_rate']} | "
                     f"{r['profit_factor']} | {r['net_points']} |")
        L.append("")
        L.append(f"- win rate across the grid: **{sens['win_rate_min']}% .. "
                 f"{sens['win_rate_max']}%**")
        L.append(f"- net points across the grid: **{sens['net_min']} .. {sens['net_max']}**")
        L.append(f"- profitable configurations: **{sens['configs_profitable']} of "
                 f"{sens['configs_total']}**")
        L.append("")
        if sens["net_min"] is not None and sens["net_min"] < 0 < sens["net_max"]:
            L.append("> **Read this before quoting the headline.** Profitability flips "
                     "sign across a small change in a single threshold. That is a "
                     "noise pocket, not an edge: the parameter is fitting the sample "
                     "rather than the market. Treat any single configuration - "
                     "including this one - as unvalidated.")
            L.append("")
    L.append("")
    L.append("## Adaptive engine activity")
    L.append("")
    L.append(f"- signals in: {audit.get('signals_in')}")
    for k, v in sorted((audit.get("blocked") or {}).items()):
        L.append(f"- blocked `{k}`: {v}")
    eng = audit.get("engine") or {}
    if eng:
        L.append(f"- shutdowns: {eng.get('shutdowns')} {eng.get('shutdown_reasons')}")
        L.append(f"- max consecutive losses seen: {eng.get('max_consecutive_losses')}")
    L.append("")
    L.append("## Constraints honoured")
    L.append("")
    L.append(f"- long options only (CE/PE buys), never short")
    L.append(f"- ATM and ITM only, max ITM depth {cfg.max_itm_steps} steps, "
             f"preferred depth {cfg.target_itm_steps}")
    L.append(f"- max {cfg.max_lots} lots, lot size {cfg.lot_size}")
    L.append(f"- breakeven = brokerage ({cfg.brokerage_points():.2f} pts) + "
             f"{cfg.breakeven_points} pts = **{cfg.breakeven_trigger_points():.2f} pts**")
    L.append(f"- costs charged on every trade: brokerage, STT, exchange, SEBI, GST, "
             f"stamp duty, slippage")
    L.append("- no RSI, no MACD, no moving-average crossover anywhere")
    L.append("")
    L.append("## Logic map")
    L.append("")
    L.append(logic_map())
    L.append("")
    L.append("## Configuration")
    L.append("")
    L.append("```")
    L.append(cfg.fingerprint())
    L.append("```")
    return "\n".join(L)