"""Metric definitions (§26): never overwrite one metric with another."""
import numpy as np
import pandas as pd

def raw_trade_stats(rets):
    r = pd.Series(rets).dropna()
    if len(r) < 2:
        return {"raw_trade_mean": float(r.mean()) if len(r) else 0.0,
                "raw_trade_sharpe": 0.0, "n": int(len(r))}
    return {"raw_trade_mean": float(r.mean()),
            "raw_trade_sharpe": float(r.mean() / r.std() * np.sqrt(len(r))) if r.std() else 0.0,
            "n": int(len(r))}

def daily_stats(rets, days):
    s = pd.Series(rets); d = pd.Series(days, index=s.index)
    by = s.groupby(d).sum()
    if len(by) < 2:
        return {"daily_sharpe": 0.0, "n_days": int(len(by))}
    return {"daily_sharpe": float(by.mean() / by.std() * np.sqrt(252)) if by.std() else 0.0,
            "n_days": int(len(by))}

def bootstrap_sharpe(rets, n_boot=500, seed=42):
    rng = np.random.default_rng(seed)
    r = pd.Series(rets).dropna().values
    if len(r) < 10:
        return {"bootstrap_sharpe": 0.0, "bootstrap_ci": (0.0, 0.0)}
    boots = [float(np.mean(rng.choice(r, size=len(r), replace=True)) /
                   (np.std(rng.choice(r, size=len(r), replace=True)) + 1e-9) * np.sqrt(len(r)))
             for _ in range(n_boot)]
    return {"bootstrap_sharpe": float(np.mean(boots)),
            "bootstrap_ci": (float(np.quantile(boots, 0.025)), float(np.quantile(boots, 0.975)))}

def surrogate_sharpe(rets, n_perm=200, seed=42):
    rng = np.random.default_rng(seed)
    r = pd.Series(rets).dropna().values
    if len(r) < 10:
        return {"surrogate_sharpe": 0.0, "surrogate_p": 1.0}
    obs = float(np.mean(r) / (np.std(r) + 1e-9) * np.sqrt(len(r)))
    surr = [float(np.mean(rng.permutation(r)) / (np.std(rng.permutation(r)) + 1e-9) * np.sqrt(len(r)))
            for _ in range(n_perm)]
    p = float((np.sum(np.abs(surr) >= abs(obs)) + 1) / (n_perm + 1))
    return {"surrogate_sharpe": obs, "surrogate_p": p,
            "why_differs": "raw uses trade-level mean/std; bootstrap resamples trades; surrogate shuffles labels (null distribution)"}

def oos_sharpe(rets_oos):
    r = pd.Series(rets_oos).dropna()
    if len(r) < 2 or r.std() == 0:
        return {"oos_sharpe": 0.0}
    return {"oos_sharpe": float(r.mean() / r.std() * np.sqrt(len(r)))}

def pf(rets):
    r = pd.Series(rets).dropna()
    pos = r[r > 0].sum(); neg = -r[r < 0].sum()
    return {"PF": float(pos / neg) if neg else float("inf")}
