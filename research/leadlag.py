"""Lead/lag discovery (spec §16) + cross-option sequences (§11). Severe multiple-testing penalty applied later."""
import pandas as pd
import numpy as np
import itertools

def leadlag_tests(feat: pd.DataFrame, focus_contracts: list, cfg) -> pd.DataFrame:
    """For each directed pair A->B and lag L: does A return_5 at t predict B fwd_ret_5m at t+L?"""
    # build per-contract series indexed by timestamp
    series = {}
    fwd = {}
    for c in focus_contracts:
        strike = c[:-2]; otype = c[-2:]
        sub = feat[(feat["strike"].astype(str) == str(strike)) & (feat["option_type"] == otype)].set_index("timestamp").sort_index()
        series[c] = sub["return_5"]
        fwd[c] = sub["fwd_ret_5m"]
    rows = []
    for A, B in itertools.permutations(focus_contracts, 2):
        sa = series[A]
        fb = fwd[B]
        for lag in cfg.lags:
            # align: signal at t, target forward return measured from t+lag
            tgt = fb.shift(-0)  # fwd already from its own timestamp
            # reindex to common timestamps, shift target back by lag
            common = sa.index.intersection(fb.index)
            s = sa.reindex(common)
            t = fb.reindex(common).shift(-lag)
            # conditioning: strong source move |ret|>1%
            mask = s.abs() > 1.0
            n = int(mask.sum())
            if n < cfg.min_raw_occurrences:
                continue
            vals = t[mask].dropna()
            if len(vals) < cfg.min_raw_occurrences:
                continue
            rows.append({
                "source": A, "target": B, "lag": lag,
                "n": int(len(vals)),
                "mean_fwd5": float(vals.mean()),
                "median_fwd5": float(vals.median()),
                "win_rate": float((vals > 0).mean()),
                "kind": f"{A[-2:]}->{B[-2:]}",
            })
    return pd.DataFrame(rows)
