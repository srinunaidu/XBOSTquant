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

def time_split(feat, mask, col="timestamp"):
    t = pd.to_datetime(feat.loc[mask, col]).dt.strftime("%H:%M")
    out = {}
    for name, a, b in [("09:15-10:00", "09:15", "10:00"), ("10:00-12:00", "10:00", "12:00"),
                       ("12:00-14:00", "12:00", "14:00"), ("14:00-15:15", "14:00", "15:15")]:
        m = mask & t.between(a, b)
        v = feat.loc[m, "fwd_ret_5m"].dropna()
        out[name] = float(v.mean()) if len(v) else float("nan")
    return out

def entry_perturbation(feat, mask, shift=1):
    # shift entry by +-1 bar within same contract; report stability
    f2 = feat.sort_values(["strike", "option_type", "timestamp"]).copy()
    f2["ret_shifted"] = f2.groupby(["strike", "option_type"])["fwd_ret_5m"].shift(shift)
    v0 = feat.loc[mask, "fwd_ret_5m"].dropna()
    v1 = f2.loc[mask, "ret_shifted"].dropna()
    return {"base": float(v0.mean()) if len(v0) else 0.0,
            "shifted": float(v1.mean()) if len(v1) else 0.0}
