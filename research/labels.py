"""Forward labels (spec §14). Must never enter feature generation — applied last."""
import pandas as pd
import numpy as np

def add_forward_labels(df: pd.DataFrame, cfg) -> pd.DataFrame:
    df = df.copy().sort_values(["strike", "option_type", "timestamp"])
    g = df.groupby(["strike", "option_type"], group_keys=False)
    for w in cfg.forward_windows:
        df[f"fwd_ret_{w}m"] = g["close"].transform(lambda s, w=w: s.shift(-w) / s * 100 - 100)
        fh = g["high"].transform(lambda s, w=w: s.shift(-w).rolling(w, min_periods=1).max())
        fl = g["low"].transform(lambda s, w=w: s.shift(-w).rolling(w, min_periods=1).min())
        # excursion relative to current close
        df[f"fwd_high_exc_{w}m"] = (g["high"].transform(
            lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).max()) - df["close"]) / df["close"] * 100
        df[f"fwd_low_exc_{w}m"] = (df["close"] - g["low"].transform(
            lambda s, w=w: s.shift(-1).rolling(w, min_periods=1).min())) / df["close"] * 100
        df[f"MFE_{w}m"] = df[f"fwd_high_exc_{w}m"]
        df[f"MAE_{w}m"] = df[f"fwd_low_exc_{w}m"]
    return df
