"""Event discovery (spec §13). Percentile/z-score normalization on past-only history."""
import pandas as pd
import numpy as np

def _past_z(s: pd.Series, H: int = 120) -> pd.Series:
    mu = s.shift(1).rolling(H, min_periods=20).mean()
    sd = s.shift(1).rolling(H, min_periods=20).std()
    return (s - mu) / sd.replace(0, np.nan)

def add_events(df: pd.DataFrame, cfg) -> pd.DataFrame:
    df = df.copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    H = cfg.rolling_history
    df["z_ret5"] = g["return_5"].transform(lambda s: _past_z(s, H))
    df["z_acc"] = g["accel_5_15"].transform(lambda s: _past_z(s, H))
    df["ev_price_shock"] = (df["z_ret5"].abs() > 2.5).astype(float)
    df["ev_volume_shock"] = df["vol_shock"]
    df["ev_range_expansion"] = (df["range_exp_roll"] > 2.0).astype(float)
    df["ev_range_compression"] = (df["range_pct"] < 10).astype(float)
    df["ev_failed_high"] = ((df["upper_wick_by_range"] > 0.6) & (df["return_1"] < 0)).astype(float)
    df["ev_failed_low"] = ((df["lower_wick_by_range"] > 0.6) & (df["return_1"] > 0)).astype(float)
    df["ev_large_wick"] = ((df["upper_wick_by_range"] > 0.5) | (df["lower_wick_by_range"] > 0.5)).astype(float)
    df["ev_consecutive"] = ((df["consecutive_up_bars"] >= 4) | (df["consecutive_down_bars"] >= 4)).astype(float)
    df["ev_accel_shock"] = (df["z_acc"].abs() > 2.5).astype(float)
    df["ev_cepe_div"] = ((df["cepe_divergence"] > 2.0)).astype(float).fillna(0)
    # cross-strike divergence/lead-lag flags from relationship cols
    retdiff_cols = [c for c in df.columns if "_retdiff" in c]
    if retdiff_cols:
        df["ev_xstrike_div"] = (df[retdiff_cols].abs().max(axis=1) > 2.0).astype(float)
    else:
        df["ev_xstrike_div"] = 0.0
    df["ev_pv_div"] = df["pv_divergence"]
    return df
