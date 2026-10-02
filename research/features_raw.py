"""Raw price-path features (spec §7). Per contract, past-only rolling stats (shifted)."""
import pandas as pd
import numpy as np

def _grouped(norm: pd.DataFrame):
    return norm.sort_values(["strike", "option_type", "timestamp"]).groupby(
        ["strike", "option_type"], group_keys=False)

def add_raw_features(norm: pd.DataFrame, cfg) -> pd.DataFrame:
    df = norm.copy()
    df = df.sort_values(["strike", "option_type", "timestamp"])
    g = df.groupby(["strike", "option_type"], group_keys=False)
    close = df["close"]
    for w in cfg.return_windows:
        df[f"return_{w}"] = g["close"].transform(lambda s: s.pct_change(w) * 100)
        df[f"abs_chg_{w}"] = g["close"].transform(lambda s: s.diff(w))
    # acceleration family (controlled, not single hard-coded)
    df["accel_3_10"] = df["return_3"] - df["return_10"] / (10 / 3)
    df["accel_5_15"] = df["return_5"] - df["return_15"] / 3.0
    df["accel_2_10"] = df["return_2"] - df["return_10"] / 5.0
    df["accel_5_10"] = df["return_5"] - df["return_10"] / 2.0
    # consecutive movement (vectorized streak count, no leakage)
    df["_sgn"] = np.sign(df["return_1"].fillna(0))
    df["_streak"] = (df["_sgn"] != g["_sgn"].shift(1).fillna(999)).cumsum() if False else 0
    # per-contract streak counting
    df["consecutive_up_bars"] = 0.0
    df["consecutive_down_bars"] = 0.0
    for _, idx in df.groupby(["strike", "option_type"]).groups.items():
        s = df.loc[idx].sort_values("timestamp")
        r1 = s["return_1"].values
        cu = np.zeros(len(s)); cd = np.zeros(len(s))
        a = b = 0
        for i, v in enumerate(r1):
            if pd.notna(v) and v > 0:
                a += 1; b = 0
            elif pd.notna(v) and v < 0:
                b += 1; a = 0
            else:
                a = b = 0
            cu[i] = a; cd[i] = b
        df.loc[s.index, "consecutive_up_bars"] = cu
        df.loc[s.index, "consecutive_down_bars"] = cd
    df = df.drop(columns=["_sgn", "_streak"])
    # candle structure
    rng = (df["high"] - df["low"]).replace(0, np.nan)
    body = (df["close"] - df["open"]).abs()
    df["body"] = body
    df["range"] = rng
    df["body_by_range"] = body / rng
    df["upper_wick_by_range"] = (df["high"] - df[["close", "open"]].max(axis=1)) / rng
    df["lower_wick_by_range"] = (df[["close", "open"]].min(axis=1) - df["low"]) / rng
    df["close_location"] = (df["close"] - df["low"]) / rng
    # price location (past-only rolling) — rebuild groupby after new cols
    H = cfg.rolling_history
    g2 = df.groupby(["strike", "option_type"], group_keys=False)
    df["rolling_mean"] = g2["close"].transform(
        lambda s: s.shift(1).rolling(H, min_periods=20).mean())
    df["rolling_high"] = g2["high"].transform(
        lambda s: s.shift(1).rolling(H, min_periods=20).max())
    df["rolling_low"] = g2["low"].transform(
        lambda s: s.shift(1).rolling(H, min_periods=20).min())
    df["dist_from_high"] = (df["close"] - df["rolling_high"]) / df["rolling_high"] * 100
    df["dist_from_low"] = (df["close"] - df["rolling_low"]) / df["rolling_low"] * 100
    df["dist_from_mean"] = (df["close"] - df["rolling_mean"]) / df["rolling_mean"] * 100
    # rolling range percentile: rank of current range in past H ranges
    def roll_pct(s):
        return s.shift(1).rolling(H, min_periods=20).apply(
            lambda w: (w <= w.iloc[-1]).mean() * 100 if len(w) else np.nan, raw=False)
    df["range_pct"] = g2["range"].transform(roll_pct)
    df["volatility_pct"] = g2["return_1"].transform(
        lambda s: s.shift(1).rolling(H, min_periods=20).std())
    # compression
    for w in (3, 5, 10):
        df[f"range_{w}"] = g2["range"].transform(lambda s, w=w: s.rolling(w).mean())
    # expansion
    df["range_exp_1"] = df["range"] / g2["range"].transform(lambda s: s.shift(1))
    df["range_exp_roll"] = df["range"] / g2["range"].transform(
        lambda s: s.shift(1).rolling(10, min_periods=5).mean())
    return df
