"""Events (§12, 2/3 combos) + sequences<=3 (§13) + states (§14). Constrained, counted."""
import pandas as pd
import numpy as np

SEQ_COUNT = {"n": 0}
STATE_COUNT = {"n": 0}

def add_atomic_events(df, H=120, type_acc_col="cepe_acc_diff"):
    df = df.copy()
    g = df.groupby("symbol", group_keys=False)
    def z(s):
        mu = s.shift(1).rolling(H, min_periods=20).mean()
        sd = s.shift(1).rolling(H, min_periods=20).std()
        return (s - mu) / sd.replace(0, np.nan)
    df["z_ret5"] = g["return_5"].transform(z)
    df["e_large_ret"] = (df["z_ret5"].abs() > 2.5).astype(float)
    df["e_vol_shock"] = (df["volume_percentile"] >= 95).astype(float).fillna(0)
    df["e_compression"] = (df["range_percentile"] < 10).astype(float).fillna(0)
    df["e_expansion"] = (df["range_expansion"] > 2.0).astype(float).fillna(0)
    acc = df[type_acc_col] if type_acc_col in df.columns else df.get("type_acc_diff")
    df["e_type_accel"] = ((acc.abs() > 1.0)).astype(float).fillna(0) if acc is not None else 0.0
    df["e_atm_move"] = (df["z_ret5"].abs() > 2.0).astype(float)
    return df

def add_combo_events(df, lead_cols=None):
    df = df.copy()
    df["ev_largeRet_volShock"] = ((df["e_large_ret"] == 1) & (df["e_vol_shock"] == 1)).astype(float)
    df["ev_compress_expand"] = ((df["e_compression"].shift(1) == 1) & (df["e_expansion"] == 1)).astype(float)
    # type-acceleration + other-type stagnation: resolved from discovered lead columns
    lead_cols = lead_cols or [c for c in df.columns if "_leads_" in c]
    if lead_cols:
        other_quiet = (df[lead_cols].sum(axis=1) == 0).astype(float)
        df["ev_typeAccel_otherStall"] = ((df["e_type_accel"] == 1) & (other_quiet == 1)).astype(float).fillna(0)
    else:
        df["ev_typeAccel_otherStall"] = ((df["e_type_accel"] == 1)).astype(float).fillna(0)
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
    df = df.sort_values(["symbol", "timestamp"]).copy()
    g = df.groupby("symbol", group_keys=False)
    for k in (1, 2, 3):
        df[f"st_m{k}"] = g["return_1"].transform(lambda s, k=k: s.shift(k).map(bar_state))
    for L in (2, 3):
        cols = [f"st_m{k}" for k in range(L, 0, -1)]
        df[f"seq{L}"] = df[cols].agg("|".join, axis=1)
        SEQ_COUNT["n"] += int(df[f"seq{L}"].nunique())
    # named 3-event chains (§13 examples)
    df["seq_compress_expand"] = (df["st_m2"] == "flat") & (df["st_m1"].isin(["strong_up", "strong_down"]))
    return df

def add_states(df, meta=None, type_diff_col="type_ret_diff", buckets=None):
    df = df.copy()
    t0 = t1 = None
    if meta and len(meta.get("option_types", [])) >= 2:
        vols = df.groupby("option_type")["volume"].sum().sort_values(ascending=False)
        t0, t1 = str(vols.index[0]), str(vols.index[1])
    diff = df[type_diff_col] if type_diff_col in df.columns else df.get("cepe_ret_diff")
    if diff is None:
        df["b_type_dom"] = "single_type"
    else:
        labels = ([f"{t1}_dom", f"{t1}_weak", "balanced", f"{t0}_weak", f"{t0}_dom"]
                  if t0 else ["t1_dom", "t1_weak", "balanced", "t0_weak", "t0_dom"])
        df["b_type_dom"] = pd.cut(diff.fillna(0),
                                  bins=[-np.inf, -1, -0.2, 0.2, 1, np.inf], labels=labels)
    def qbin(s):
        try:
            return pd.qcut(s, 5, labels=["vlow", "low", "mid", "high", "vhigh"], duplicates="drop")
        except Exception:
            return pd.cut(s, 5)
    df["b_vol_regime"] = df.groupby("symbol")["range_expansion"].transform(
        lambda s: qbin(s.fillna(1)))
    df["b_vol"] = df.groupby("symbol")["volume_percentile"].transform(
        lambda s: pd.cut(s.fillna(50), bins=[-1, 25, 50, 75, 95, 101],
                         labels=["low_vol", "midlow", "midhigh", "high_vol", "shock"]))
    df["state_id"] = (df["b_vol_regime"].astype(str) + "/" + df["b_type_dom"].astype(str)
                      + "/" + df["b_vol"].astype(str))
    STATE_COUNT["n"] = int(df["state_id"].nunique())
    return df
