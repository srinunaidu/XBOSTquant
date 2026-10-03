"""Forward labels (§15): 1/3/5/10/15m, MFE/MAE, absolute + percentage. Never used in features."""
import pandas as pd

FW = (1, 3, 5, 10, 15, 30)

def add_labels(df):
    df = df.sort_values(["symbol", "timestamp"]).copy()
    g = df.groupby("symbol", group_keys=False)
    for w in FW:
        df[f"fwd_ret_{w}m"] = g["close"].transform(lambda s, w=w: s.shift(-w) / s * 100 - 100)
        df[f"fwd_abs_{w}m"] = g["close"].transform(lambda s, w=w: s.shift(-w) - s)
        df[f"MFE_{w}m"] = (g["high"].transform(lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).max()) - df["close"]) / df["close"] * 100
        df[f"MAE_{w}m"] = (df["close"] - g["low"].transform(lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).min())) / df["close"] * 100
        df[f"MFE_abs_{w}m"] = g["high"].transform(lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).max()) - df["close"]
        df[f"MAE_abs_{w}m"] = df["close"] - g["low"].transform(lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).min())
    return df
