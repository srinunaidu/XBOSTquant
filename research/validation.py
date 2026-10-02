"""Chronological validation, clustering, concentration, best-event removal, permutation, multiple-testing (spec §21-27)."""
import pandas as pd
import numpy as np

def chronological_splits(dates: list, fractions=(0.5, 0.2, 0.2, 0.1)):
    dates = sorted(dates)
    n = len(dates)
    i1 = int(n * fractions[0]); i2 = i1 + int(n * fractions[1]); i3 = i2 + int(n * fractions[2])
    return {
        "discovery": dates[:i1], "refinement": dates[i1:i2],
        "pseudo_oos": dates[i2:i3], "holdout": dates[i3:],
    }

def cluster_events(sig: pd.DataFrame, minutes: int = 3) -> pd.DataFrame:
    """Signals within same burst -> 1 independent event. Group by contract, sort by time."""
    sig = sig.sort_values(["strike", "option_type", "timestamp"]).copy()
    sig["event_id"] = -1
    eid = 0
    for _, grp in sig.groupby(["strike", "option_type"]):
        idx = grp.index.tolist()
        times = pd.to_datetime(grp["timestamp"])
        last = None
        cur = -1
        for i, t in zip(idx, times):
            if last is None or (t - last).total_seconds() / 60 > minutes:
                eid += 1
                cur = eid
            sig.loc[i, "event_id"] = cur
            last = t
    return sig

def candidate_stats(vals: pd.Series, day_labels: pd.Series) -> dict:
    v = vals.dropna()
    if len(v) == 0:
        return {"n": 0}
    tot = v.sum()
    order = v.sort_values(ascending=False)
    def contrib(k):
        return float(order.head(k).sum() / tot) if tot != 0 else 0.0
    byday = v.groupby(day_labels.loc[v.index]).sum()
    return {
        "n": int(len(v)),
        "mean": float(v.mean()), "median": float(v.median()),
        "win_rate": float((v > 0).mean()),
        "expectancy": float(v.mean()),
        "top1": contrib(1), "top3": contrib(3), "top5": contrib(5), "top10": contrib(10),
        "best_day_contrib": float(byday.max() / tot) if tot != 0 and len(byday) else 0.0,
        "worst_day_contrib": float(byday.min() / tot) if tot != 0 and len(byday) else 0.0,
        "largest_winner": float(v.max()), "largest_loser": float(v.min()),
        "days": int(day_labels.loc[v.index].nunique()),
    }

def best_removal(vals: pd.Series, day_labels: pd.Series) -> dict:
    v = vals.dropna().sort_values()
    out = {}
    for k, name in [(1, "rm_best1"), (3, "rm_best3"), (5, "rm_best5")]:
        r = v.iloc[:-k] if len(v) > k else v.iloc[0:0]
        out[name] = float(r.mean()) if len(r) else float("nan")
    byday = vals.groupby(day_labels.loc[vals.index]).sum().sort_values()
    for k, name in [(1, "rm_bestday1"), (2, "rm_bestday2")]:
        keep_days = byday.iloc[:-k].index if len(byday) > k else byday.iloc[0:0].index
        r = vals[day_labels.isin(keep_days)]
        out[name] = float(r.mean()) if len(r) else float("nan")
    return out

def permutation_pvalue(vals: pd.Series, stat_fn=np.mean, n_perm: int = 200, seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    v = vals.dropna().values
    if len(v) < 10:
        return {"p": 1.0, "observed": float(np.mean(v)) if len(v) else 0.0, "n_perm": n_perm}
    obs = float(stat_fn(v))
    rand = np.array([float(stat_fn(rng.permutation(v))) for _ in range(n_perm)])
    p = float((np.sum(np.abs(rand) >= abs(obs)) + 1) / (n_perm + 1))
    return {"p": p, "observed": obs, "n_perm": n_perm,
            "rand_mean": float(rand.mean()), "rand_std": float(rand.std())}

def bh_correction(pvals: np.ndarray) -> np.ndarray:
    """Benjamini-Hochberg FDR adjusted p-values."""
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    order = np.argsort(p)
    adj = np.empty(n)
    prev = 1.0
    for i in reversed(range(n)):
        rank = i + 1
        val = min(prev, p[order[i]] * n / rank)
        adj[order[i]] = val
        prev = val
    return adj
