"""Robustness (§24): param/time/CE-PE/strike/perturb/best-removal/concentration/dependence."""
import pandas as pd
import numpy as np
def concentration(vals):
    v = pd.Series(vals).dropna().sort_values(ascending=False)
    tot = v.sum()
    if tot == 0 or len(v) == 0:
        return {"top1": 1.0, "top5": 1.0, "top10": 1.0}
    return {"top1": float(v.head(1).sum() / tot), "top5": float(v.head(5).sum() / tot),
            "top10": float(v.head(10).sum() / tot),
            "largest_event": float(v.max()), "largest_loser": float(v.min())}

def best_removal(vals, days, ks=(1, 3, 5, 10)):
    v = pd.Series(vals).dropna().sort_values()
    d = pd.Series(days, index=pd.Series(vals).index)
    out = {}
    for k in ks:
        r = v.iloc[:-k] if len(v) > k else v.iloc[0:0]
        out[f"rm_best{k}"] = float(r.mean()) if len(r) else float("nan")
    by = pd.Series(vals).groupby(d).sum().sort_values()
    keep = by.iloc[:-1].index if len(by) > 1 else by.iloc[0:0].index
    r = pd.Series(vals)[d.isin(keep)]
    out["rm_bestday1"] = float(r.mean()) if len(r) else float("nan")
    return out

def session_windows(feat, mask, n_windows=4, col="timestamp"):
    """Divide the OBSERVED session into n equal time windows (§36). No hardcoded times."""
    t = pd.to_datetime(feat.loc[mask, col])
    if len(t) == 0:
        return []
    mins = t.dt.hour * 60 + t.dt.minute + t.dt.second / 60
    qs = [float(mins.quantile(q)) for q in [i / n_windows for i in range(n_windows + 1)]]

    def _f(m):
        return f"{int(m // 60):02d}:{int(m % 60):02d}"

    return [(f"W{i + 1}:{_f(qs[i])}-{_f(qs[i + 1])}", _f(qs[i]), _f(qs[i + 1]))
            for i in range(n_windows)]


def time_split(feat, mask, col="timestamp", n_windows=4):
    t = pd.to_datetime(feat.loc[mask, col]).dt.strftime("%H:%M")
    out = {}
    for name, a, b in session_windows(feat, mask, n_windows, col):
        m = mask & t.between(a, b)
        v = feat.loc[m, "fwd_ret_5m"].dropna()
        out[name] = float(v.mean()) if len(v) else float("nan")
    return out

def entry_perturbation(feat, mask, shift=1):
    # shift entry by +-1 bar within same contract; report stability
    f2 = feat.sort_values(["symbol", "timestamp"]).copy()
    f2["ret_shifted"] = f2.groupby("symbol")["fwd_ret_5m"].shift(shift)
    v0 = feat.loc[mask, "fwd_ret_5m"].dropna()
    v1 = f2.loc[mask, "ret_shifted"].dropna()
    return {"base": float(v0.mean()) if len(v0) else 0.0,
            "shifted": float(v1.mean()) if len(v1) else 0.0}

def exit_independence(feat, mask, cid, hold_bars=5):
    """§39: same entries under independent exit methods. Signal must not depend on one exit."""
    from .backtest import backtest
    variants = {
        "time": dict(exit_mode="time", sl=99.0, tp=99.0),
        "sl_tp": dict(exit_mode="premium", sl=0.5, tp=1.0),
        "wide": dict(exit_mode="premium", sl=1.0, tp=2.0),
        "trail": dict(exit_mode="premium", sl=0.5, tp=5.0, trail=0.5),
    }
    perfs = {}
    for name, kw in variants.items():
        try:
            led = backtest(feat, mask, hold_bars=hold_bars, cid=f"{cid}:{name}", **kw)
            perfs[name] = float(led["ret"].mean()) if len(led) else float("nan")
        except Exception:
            perfs[name] = float("nan")
    vals = pd.Series(perfs).dropna()
    return {"n_variants": len(variants), "profitable_variants": int((vals > 0).sum()),
            "median_performance": float(vals.median()) if len(vals) else float("nan"),
            "worst_performance": float(vals.min()) if len(vals) else float("nan"),
            "best_performance": float(vals.max()) if len(vals) else float("nan"),
            "per_exit": perfs}


def parameter_neighborhood(base_expectancy_fn, param_grid):
    """§38: expectancy over neighboring parameter values. Returns density stats."""
    vals = []
    for params in param_grid:
        try:
            vals.append(float(base_expectancy_fn(params)))
        except Exception:
            continue
    vals = pd.Series(vals).dropna()
    if len(vals) == 0:
        return {"profitable_density": 0.0, "positive_expectancy_density": 0.0,
                "median_score": float("nan"), "worst_score": float("nan"),
                "best_score": float("nan"), "standard_deviation": float("nan"),
                "performance_drop": float("nan"), "knife_edge": True}
    peak = vals.max()
    return {"profitable_density": float((vals > 0).mean()),
            "positive_expectancy_density": float((vals > 0).mean()),
            "median_score": float(vals.median()), "worst_score": float(vals.min()),
            "best_score": float(peak), "standard_deviation": float(vals.std()),
            "performance_drop": float(peak - vals.median()),
            "knife_edge": bool((vals > 0).mean() < 0.4)}


def robustness_score(components: dict) -> dict:
    """§40: configurable 0-10 score. Every component explicit; weakest dims dominate."""
    w = {"signal": 1.5, "sample": 1.5, "param": 1.0, "time": 1.0, "contract": 1.0,
         "oos": 1.5, "exit": 0.5, "concentration": 0.5, "best_event": 0.25, "stats": 0.25}
    total = sum(w.values())
    score = sum(max(0.0, min(1.0, components.get(k, 0.0))) * w[k] for k in w) / total * 10
    # hard vetoes: OOS rejection or surrogate failure cap the score
    if components.get("oos", 0) <= 0 or components.get("stats", 0) <= 0:
        score = min(score, 3.0)
    return {"robustness_score": round(float(score), 2),
            "components": {k: round(float(components.get(k, 0.0)), 3) for k in w},
            "weights": w}
