"""Canonical metric engine (§21-23). ONE function owns the ledger -> metrics path.
Zero means measured-zero. Incalculable means NA (None), never 0.
"""
import numpy as np
import pandas as pd

NA = float("nan")

def _fmt(x):
    return "NA" if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 6)

SHARPE_DEFS = {
    "TRADE_SHARPE": {"formula": "mean(trade_rets)/std(trade_rets)*sqrt(N_trades)",
                     "sample_unit": "trade", "annualization": "none (trade-count scaled)",
                     "aggregation": "trade-level, no time aggregation"},
    "DAILY_SHARPE": {"formula": "mean(daily_pnl)/std(daily_pnl)*sqrt(252)",
                     "sample_unit": "trading day", "annualization": "sqrt(252)",
                     "aggregation": "sum trades within day, then Sharpe over days"},
    "BOOTSTRAP_SHARPE": {"formula": "mean over 500 resampled TRADE_SHARPE",
                         "sample_unit": "bootstrap resample of trades", "annualization": "same as TRADE_SHARPE",
                         "aggregation": "resample-with-replacement, report mean + 2.5/97.5 CI"},
    "SURROGATE_SHARPE": {"formula": "TRADE_SHARPE on label-permuted trades; p = P(|surr|>=|obs|)",
                         "sample_unit": "permuted trade list", "annualization": "same as TRADE_SHARPE",
                         "aggregation": "200 permutations, null distribution + percentile"},
    "OOS_SHARPE": {"formula": "mean(oos_rets)/std(oos_rets)*sqrt(N_oos)",
                   "sample_unit": "OOS trade", "annualization": "none (OOS-count scaled)",
                   "aggregation": "OOS trades only, never mixed with IS"},
}

def calculate_trade_metrics(trades: pd.DataFrame) -> dict:
    """Single canonical path: trades ledger -> all metrics. trades needs ret, mae, mfe cols (pct)."""
    if trades is None or len(trades) == 0:
        return {"trade_count": 0, "wins": 0, "losses": 0, "avg_winner": NA, "avg_loser": NA,
                "expectancy": NA, "PF": NA, "TRADE_SHARPE": NA, "Sortino": NA,
                "MAE": NA, "MFE": NA, "P&L": 0.0}
    r = pd.to_numeric(trades["ret"], errors="coerce").dropna()
    n = int(len(r))
    wins = int((r > 0).sum()); losses = int((r < 0).sum())
    pos = r[r > 0]; neg = r[r < 0]
    avg_w = float(pos.mean()) if len(pos) else NA
    avg_l = float(neg.mean()) if len(neg) else NA
    exp = float(r.mean()) if n else NA
    pf = float(pos.sum() / -neg.sum()) if len(neg) and neg.sum() != 0 else (float("inf") if len(pos) else NA)
    ts = float(r.mean() / r.std() * np.sqrt(n)) if n >= 2 and r.std() not in (0, None) and not np.isnan(r.std()) else NA
    dn = r[r < 0].std()
    sort = float(r.mean() / dn * np.sqrt(n)) if n >= 2 and pd.notna(dn) and dn not in (0,) else NA
    mae = float(pd.to_numeric(trades["mae"], errors="coerce").mean()) if "mae" in trades else NA
    mfe = float(pd.to_numeric(trades["mfe"], errors="coerce").mean()) if "mfe" in trades else NA
    if "mae" in trades and pd.to_numeric(trades["mae"], errors="coerce").isna().all():
        mae = NA
    if "mfe" in trades and pd.to_numeric(trades["mfe"], errors="coerce").isna().all():
        mfe = NA
    return {"trade_count": n, "wins": wins, "losses": losses, "avg_winner": avg_w,
            "avg_loser": avg_l, "expectancy": exp, "PF": pf, "TRADE_SHARPE": ts,
            "Sortino": sort, "MAE": mae, "MFE": mfe, "P&L": float(r.sum())}

def metric_recalculation_test(reported: dict, trades: pd.DataFrame, tol=1e-6) -> dict:
    """METRIC_RECALCULATION_TEST (§22): recompute from ledger, compare."""
    re = calculate_trade_metrics(trades)
    diffs = {}
    ok = True
    for k in ["trade_count", "wins", "losses", "avg_winner", "avg_loser",
              "expectancy", "PF", "TRADE_SHARPE", "P&L"]:
        a, b = reported.get(k), re.get(k)
        if pd.isna(a) and pd.isna(b):
            diffs[k] = 0.0
        elif pd.isna(a) or pd.isna(b):
            # one NA one number — only ok if both NA-like; else fail unless both inf
            diffs[k] = float("inf"); ok = False
        else:
            d = abs(float(a) - float(b))
            diffs[k] = d
            if not (d <= tol or (np.isinf(a) and np.isinf(b))):
                ok = False
    return {"METRIC_INTEGRITY": "PASS" if ok else "FAIL", "differences": diffs,
            "recalculated": {k: _fmt(v) for k, v in re.items()}}

# ---- legacy split-metric helpers (kept separate, never overwritten) ----
def daily_sharpe(rets, days):
    s = pd.Series(list(rets)); d = pd.Series(list(days), index=s.index)
    by = s.groupby(d).sum()
    if len(by) < 2 or by.std() == 0 or pd.isna(by.std()):
        return {"DAILY_SHARPE": NA, "n_days": int(len(by)), **{"_def": SHARPE_DEFS["DAILY_SHARPE"]}}
    return {"DAILY_SHARPE": float(by.mean() / by.std() * np.sqrt(252)),
            "n_days": int(len(by)), "_def": SHARPE_DEFS["DAILY_SHARPE"]}

def bootstrap_sharpe(rets, n_boot=500, seed=42):
    rng = np.random.default_rng(seed)
    r = pd.Series(list(rets)).dropna().values
    if len(r) < 10:
        return {"BOOTSTRAP_SHARPE": NA, "bootstrap_ci": ("NA", "NA"), "_def": SHARPE_DEFS["BOOTSTRAP_SHARPE"]}
    boots = []
    for _ in range(n_boot):
        s = rng.choice(r, size=len(r), replace=True)
        boots.append(float(np.mean(s) / (np.std(s) + 1e-9) * np.sqrt(len(s))))
    return {"BOOTSTRAP_SHARPE": float(np.mean(boots)),
            "bootstrap_ci": (float(np.quantile(boots, 0.025)), float(np.quantile(boots, 0.975))),
            "_def": SHARPE_DEFS["BOOTSTRAP_SHARPE"]}

def surrogate_stats(rets, n_perm=200, seed=42):
    rng = np.random.default_rng(seed)
    r = pd.Series(list(rets)).dropna().values
    if len(r) < 10:
        return {"SURROGATE_SHARPE": NA, "p_value": NA, "observed_percentile": NA,
                "_def": SHARPE_DEFS["SURROGATE_SHARPE"]}
    obs = float(np.mean(r) / (np.std(r) + 1e-9) * np.sqrt(len(r)))
    surr = np.array([float(np.mean(p) / (np.std(p) + 1e-9) * np.sqrt(len(p)))
                     for p in (rng.permutation(r) for _ in range(n_perm))])
    p = float((np.sum(np.abs(surr) >= abs(obs)) + 1) / (n_perm + 1))
    return {"SURROGATE_SHARPE": obs, "surrogate_mean": float(surr.mean()),
            "surrogate_sd": float(surr.std()), "observed_percentile": float((surr < obs).mean() * 100),
            "p_value": p, "_def": SHARPE_DEFS["SURROGATE_SHARPE"],
            "note": "differs from TRADE_SHARPE because it is the null distribution under label permutation; high raw + p~0.9 means effect is not distinguishable from noise"}
