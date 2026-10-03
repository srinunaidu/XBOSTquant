"""Forward labels (§15): 1/3/5/10/15m, MFE/MAE, absolute + percentage. Never used in features."""
import pandas as pd

FW = (1, 3, 5, 10, 15, 30)

def _forward_roll(s, w, agg):
    """max/min over the next w bars STRICTLY AFTER each bar: i+1 .. i+w."""
    rev = s[::-1]
    r = rev.rolling(w, min_periods=w)
    v = (r.max() if agg == "max" else r.min())[::-1]
    return v.shift(-1)


def add_labels(df):
    df = df.sort_values(["symbol", "timestamp"]).copy()
    g = df.groupby("symbol", group_keys=False)
    for w in FW:
        df[f"fwd_ret_{w}m"] = g["close"].transform(lambda s, w=w: s.shift(-w) / s * 100 - 100)
        df[f"fwd_abs_{w}m"] = g["close"].transform(lambda s, w=w: s.shift(-w) - s)
        hi = g["high"].transform(lambda s, w=w: _forward_roll(s, w, "max"))
        lo = g["low"].transform(lambda s, w=w: _forward_roll(s, w, "min"))
        df[f"MFE_{w}m"] = (hi - df["close"]) / df["close"] * 100
        df[f"MAE_{w}m"] = (df["close"] - lo) / df["close"] * 100
        df[f"MFE_abs_{w}m"] = hi - df["close"]
        df[f"MAE_abs_{w}m"] = df["close"] - lo
    return df
