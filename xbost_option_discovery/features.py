"""Raw (§6) + volume (§7) features + indicator BASELINES (§5/§30). Past-only. Counts tested."""
import pandas as pd
import numpy as np

FEATURE_COUNT = {"n": 0}

def _bump(n=1):
    FEATURE_COUNT["n"] += n

def add_raw(df, H=120):
    df = df.sort_values(["strike", "option_type", "timestamp"]).copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    for w in (1, 2, 3, 5, 10, 15):
        df[f"return_{w}"] = g["close"].transform(lambda s, w=w: s.pct_change(w) * 100)
        _bump()
    df["accel_1_2"] = df["return_1"] - df["return_2"]; _bump()
    df["accel_1_3"] = df["return_1"] - df["return_3"]; _bump()
    df["accel_3_10"] = df["return_3"] - df["return_10"] / (10 / 3); _bump()
    # streaks
    df["consecutive_up_bars"] = 0.0; df["consecutive_down_bars"] = 0.0
    df["same_direction_streak"] = 0.0
    for _, idx in df.groupby(["strike", "option_type"]).groups.items():
        s = df.loc[idx].sort_values("timestamp")
        r1 = s["return_1"].values
        cu = np.zeros(len(s)); cd = np.zeros(len(s)); cs = np.zeros(len(s))
        a = b = 0; last = 0; cur = 0
        for i, v in enumerate(r1):
            if pd.notna(v) and v > 0: a += 1; b = 0; cur = cur + 1 if last > 0 else 1; last = 1
            elif pd.notna(v) and v < 0: b += 1; a = 0; cur = cur + 1 if last < 0 else 1; last = -1
            else: a = b = 0; cur = 0; last = 0
            cu[i] = a; cd[i] = b; cs[i] = cur
        df.loc[s.index, "consecutive_up_bars"] = cu
        df.loc[s.index, "consecutive_down_bars"] = cd
        df.loc[s.index, "same_direction_streak"] = cs
    _bump(3)
    rng = (df["high"] - df["low"]).replace(0, np.nan)
    body = (df["close"] - df["open"])
    df["body"] = body; df["body_pct"] = body / df["open"] * 100
    df["upper_wick"] = df["high"] - df[["close", "open"]].max(axis=1)
    df["lower_wick"] = df[["close", "open"]].min(axis=1) - df["low"]
    df["range"] = rng
    df["close_location"] = (df["close"] - df["low"]) / rng
    df["body_to_range"] = body.abs() / rng
    _bump(7)
    g2 = df.groupby(["strike", "option_type"], group_keys=False)
    df["rolling_mean"] = g2["close"].transform(lambda s: s.shift(1).rolling(H, min_periods=20).mean())
    df["rolling_high"] = g2["high"].transform(lambda s: s.shift(1).rolling(H, min_periods=20).max())
    df["rolling_low"] = g2["low"].transform(lambda s: s.shift(1).rolling(H, min_periods=20).min())
    df["distance_from_recent_high"] = (df["close"] - df["rolling_high"]) / df["rolling_high"] * 100
    df["distance_from_recent_low"] = (df["close"] - df["rolling_low"]) / df["rolling_low"] * 100
    df["range_position"] = (df["close"] - df["rolling_low"]) / (df["rolling_high"] - df["rolling_low"]).replace(0, np.nan)
    df["distance_from_mean"] = (df["close"] - df["rolling_mean"]) / df["rolling_mean"] * 100
    _bump(4)
    df["atr"] = g2["range"].transform(lambda s: s.shift(1).rolling(14, min_periods=5).mean())
    def roll_pct(s):
        return s.shift(1).rolling(H, min_periods=20).apply(
            lambda w: (w <= w.iloc[-1]).mean() * 100 if len(w) else np.nan, raw=False)
    df["range_percentile"] = g2["range"].transform(roll_pct)
    df["ATR_percentile"] = g2["atr"].transform(roll_pct)
    df["range_expansion"] = df["range"] / g2["range"].transform(lambda s: s.shift(1).rolling(10, min_periods=5).mean())
    df["range_contraction"] = 1 / df["range_expansion"].replace(0, np.nan)
    _bump(4)
    return df

def add_volume(df, H=120):
    df = df.copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    df["volume_change"] = g["volume"].transform(lambda s: s.pct_change() * 100)
    mu = g["volume"].transform(lambda s: s.shift(1).rolling(H, min_periods=20).mean())
    sd = g["volume"].transform(lambda s: s.shift(1).rolling(H, min_periods=20).std())
    df["volume_zscore"] = (df["volume"] - mu) / sd.replace(0, np.nan)
    def roll_pct(s):
        return s.shift(1).rolling(H, min_periods=20).apply(
            lambda w: (w <= w.iloc[-1]).mean() * 100 if len(w) else np.nan, raw=False)
    df["volume_percentile"] = g["volume"].transform(roll_pct)
    df["volume_shock"] = (df["volume_percentile"] >= 95).astype(float)
    df["price_volume_confirmation"] = ((df["volume_percentile"] >= 75) & (df["range_expansion"] > 1.5)).astype(float)
    df["price_volume_divergence"] = ((df["volume_percentile"] >= 90) & (df["return_1"].abs() < 0.2)).astype(float)
    df["volume_expansion_without_price"] = ((df["volume_percentile"] >= 90) & (df["return_1"].abs() < 0.5)).astype(float)
    df["price_expansion_without_volume"] = ((df["volume_percentile"] <= 25) & (df["range_expansion"] > 1.5)).astype(float)
    _bump(9)
    return df

def add_baselines(df):
    """BASELINE ONLY (§5): RSI, BB, VWAP-ref, momentum/ROC, MACD, ATR, MA. Never primary."""
    df = df.copy()
    g = df.groupby(["strike", "option_type"], group_keys=False)
    delta = g["close"].transform(lambda s: s.diff())
    gain = delta.clip(lower=0); loss = -delta.clip(upper=0)
    ag = gain.groupby(df.groupby(["strike", "option_type"]).ngroup()).transform(lambda s: s.rolling(14, min_periods=5).mean())
    # simpler per-group RSI
    def rsi(s):
        d = s.diff(); u = d.clip(lower=0).rolling(14, min_periods=5).mean()
        dd = -d.clip(upper=0).rolling(14, min_periods=5).mean()
        return 100 - 100 / (1 + u / dd.replace(0, np.nan))
    df["BASELINE_RSI"] = g["close"].transform(rsi)
    df["BASELINE_MA20"] = g["close"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).mean())
    df["BASELINE_ROC5"] = g["close"].transform(lambda s: s.pct_change(5) * 100)
    mm = g["close"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).mean())
    ss = g["close"].transform(lambda s: s.shift(1).rolling(20, min_periods=10).std())
    df["BASELINE_BB_pos"] = (df["close"] - mm) / ss.replace(0, np.nan)
    df["BASELINE_ATR"] = df["atr"] if "atr" in df.columns else np.nan
    cumv = g["volume"].transform(lambda s: s.cumsum())
    cump = (df["close"] * df["volume"]).groupby(df.groupby(["strike", "option_type"]).ngroup()).cumsum()
    df["BASELINE_VWAP_dev"] = (df["close"] - cump / cumv.replace(0, np.nan)) / df["close"] * 100
    return df
