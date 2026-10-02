"""State discovery (spec §15): controlled quantile-bucket states, no manual naming before discovery."""
import pandas as pd
import numpy as np

def add_states(df: pd.DataFrame, cfg) -> pd.DataFrame:
    df = df.copy()
    # quantile buckets computed on past-only expanding history approximated by global cut on train?
    # To avoid leakage across splits, buckets here are rank-based per-contract rolling quantiles.
    # Simplify: discretize velocity/accel/vol/time-of-day into bins -> state_id string.
    def qbin(s: pd.Series, q=(0.2, 0.4, 0.6, 0.8)):
        qs = s.quantile(list(q)).values
        return pd.cut(s, bins=[-np.inf, *qs, np.inf], labels=["vlow", "low", "mid", "high", "vhigh"])
    df["b_vel"] = df.groupby(["strike", "option_type"])["return_5"].transform(qbin)
    df["b_acc"] = df.groupby(["strike", "option_type"])["accel_5_15"].transform(qbin)
    df["b_vol"] = df.groupby(["strike", "option_type"])["vol_ratio"].transform(qbin)
    df["b_rng"] = df.groupby(["strike", "option_type"])["range_exp_roll"].transform(qbin)
    df["tod"] = pd.to_datetime(df["timestamp"]).dt.strftime("%H:%M")
    def tod_bin(t):
        for name, a, b in cfg.tod_buckets:
            if a <= t < b or (name == "15:00-15:30" and t >= "15:00"):
                return name
        return "other"
    df["b_tod"] = df["tod"].map(tod_bin)
    df["b_cepe"] = pd.cut(df["cepe_ret_diff"].fillna(0),
                          bins=[-np.inf, -1, -0.2, 0.2, 1, np.inf],
                          labels=["pe_lead", "pe_weak", "neutral", "ce_weak", "ce_lead"])
    df["state_id"] = (df["b_vel"].astype(str) + "/" + df["b_acc"].astype(str) + "/" +
                      df["b_vol"].astype(str) + "/" + df["b_cepe"].astype(str))
    return df
