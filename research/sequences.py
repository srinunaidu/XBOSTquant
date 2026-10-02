"""Sequence / pattern mining (spec §17): 3/4/5-bar alphabets. Past returns only."""
import pandas as pd
import numpy as np

def bar_state(r: float) -> str:
    if pd.isna(r):
        return "NA"
    if r > 1.0:
        return "strong_up"
    if r > 0.2:
        return "weak_up"
    if r < -1.0:
        return "strong_down"
    if r < -0.2:
        return "weak_down"
    return "flat"

def add_sequences(df: pd.DataFrame, cfg) -> pd.DataFrame:
    df = df.copy().sort_values(["strike", "option_type", "timestamp"])
    g = df.groupby(["strike", "option_type"], group_keys=False)
    # shifted state columns: state of bar t-k
    for k in range(1, 6):
        df[f"st_m{k}"] = g["return_1"].transform(lambda s, k=k: s.shift(k).map(bar_state))
    for L in cfg.seq_lengths:
        cols = [f"st_m{k}" for k in range(L, 0, -1)]
        df[f"seq_{L}"] = df[cols].agg("|".join, axis=1)
    return df
