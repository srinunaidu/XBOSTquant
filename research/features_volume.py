"""Volume-pattern discovery (spec §8). Past-only normalization, no causal labels."""
import pandas as pd
import numpy as np

def add_volume_features(df: pd.DataFrame, cfg) -> pd.DataFrame:
    df = df.copy()
    H = cfg.rolling_history
    g = df.groupby(["strike", "option_type"], group_keys=False)
    df["vol_mean"] = g["volume"].transform(
        lambda s: s.shift(1).rolling(H, min_periods=20).mean())
    df["vol_ratio"] = df["volume"] / df["vol_mean"]
    def roll_pct(s):
        return s.shift(1).rolling(H, min_periods=20).apply(
            lambda w: (w <= w.iloc[-1]).mean() * 100 if len(w) else np.nan, raw=False)
    df["vol_pct"] = g["volume"].transform(roll_pct)
    df["vol_accel"] = df["vol_ratio"] / g["vol_ratio"].transform(lambda s: s.shift(1))
    df["vol_shock"] = (df["vol_pct"] >= 95).astype(float)
    df["pv_divergence"] = ((df["vol_pct"] >= 90) & (df["return_1"].abs() < 0.2)).astype(float)
    df["lowvol_expansion"] = ((df["vol_pct"] <= 25) & (df["range_exp_roll"] > 1.5)).astype(float)
    df["vol_confirmation"] = ((df["vol_pct"] >= 75) & (df["range_exp_roll"] > 1.5)).astype(float)
    df["ret_by_vol"] = df["return_1"].abs() / df["vol_ratio"].replace(0, np.nan)
    return df
