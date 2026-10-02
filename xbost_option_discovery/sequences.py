"""Events (§12, 2/3 combos) + sequences<=3 (§13) + states (§14). Constrained, counted."""
import pandas as pd
import numpy as np

SEQ_COUNT = {"n": 0}
STATE_COUNT = {"n": 0}

def add_atomic_events(df, H=120):
    df = df.copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    def z(s):
        mu = s.shift(1).rolling(H, min_periods=20).mean()
        sd = s.shift(1).rolling(H, min_periods=20).std()
        return (s - mu) / sd.replace(0, np.nan)
    df["z_ret5"] = g["return_5"].transform(z)
    df["e_large_ret"] = (df["z_ret5"].abs() > 2.5).astype(float)
    df["e_vol_shock"] = (df["volume_percentile"] >= 95).astype(float).fillna(0)
    df["e_compression"] = (df["range_percentile"] < 10).astype(float).fillna(0)
    df["e_expansion"] = (df["range_expansion"] > 2.0).astype(float).fillna(0)
    df["e_ce_accel"] = ((df["cepe_acc_diff"].abs() > 1.0)).astype(float).fillna(0)
    df["e_atm_move"] = (df["z_ret5"].abs() > 2.0).astype(float)
    return df

def add_combo_events(df):
    df = df.copy()
    df["ev_largeRet_volShock"] = ((df["e_large_ret"] == 1) & (df["e_vol_shock"] == 1)).astype(float)
    df["ev_compress_expand"] = ((df["e_compression"].shift(1) == 1) & (df["e_expansion"] == 1)).astype(float)
    df["ev_ceAccel_peStall"] = ((df["e_ce_accel"] == 1) & (df["ev_pe_leads_ce"] == 0)).astype(float).fillna(0)
    df["ev_atm_neighbor"] = ((df["e_atm_move"] == 1)).astype(float)
    # one 3-event combo
    df["ev_ret_vol_expand"] = ((df["e_large_ret"] == 1) & (df["e_vol_shock"] == 1) & (df["e_expansion"] == 1)).astype(float)
    SEQ_COUNT["n"] += 5
    return df

def bar_state(r):
    if pd.isna(r): return "NA"
    if r > 1.0: return "strong_up"
    if r > 0.2: return "weak_up"
    if r < -1.0: return "strong_down"
    if r < -0.2: return "weak_down"
    return "flat"

def add_sequences(df, max_len=3):
    df = df.sort_values(["strike", "option_type", "timestamp"]).copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    for k in (1, 2, 3):
        df[f"st_m{k}"] = g["return_1"].transform(lambda s, k=k: s.shift(k).map(bar_state))
    for L in (2, 3):
        cols = [f"st_m{k}" for k in range(L, 0, -1)]
        df[f"seq{L}"] = df[cols].agg("|".join, axis=1)
        SEQ_COUNT["n"] += int(df[f"seq{L}"].nunique())
    # named 3-event chains (§13 examples)
    df["seq_compress_expand"] = (df["st_m2"] == "flat") & (df["st_m1"].isin(["strong_up", "strong_down"]))
    return df

def add_states(df, buckets=None):
    df = df.copy()
    def qbin(s):
        try:
            return pd.qcut(s, 5, labels=["vlow", "low", "mid", "high", "vhigh"], duplicates="drop")
        except Exception:
            return pd.cut(s, 5)
    df["b_vol_regime"] = df.groupby(["strike", "option_type"])["range_expansion"].transform(
        lambda s: qbin(s.fillna(1)))
    df["b_ce_dom"] = pd.cut(df["cepe_ret_diff"].fillna(0),
                            bins=[-np.inf, -1, -0.2, 0.2, 1, np.inf],
                            labels=["pe_dom", "pe_weak", "balanced", "ce_weak", "ce_dom"])
    df["b_vol"] = df.groupby(["strike", "option_type"])["volume_percentile"].transform(
        lambda s: pd.cut(s.fillna(50), bins=[-1, 25, 50, 75, 95, 101],
                         labels=["low_vol", "midlow", "midhigh", "high_vol", "shock"]))
    df["state_id"] = (df["b_vol_regime"].astype(str) + "/" + df["b_ce_dom"].astype(str)
                      + "/" + df["b_vol"].astype(str))
    STATE_COUNT["n"] = int(df["state_id"].nunique())
    return df
