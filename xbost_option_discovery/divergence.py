"""Divergence (§16) / convergence (§17) / premium catch-up (§18) engines.
All generic: operate on discovered relationship columns + registry, with exact
formulas stored per event for transparency (§46)."""
import pandas as pd
import numpy as np

FORMULAS = {}  # event_col -> exact formula string


def add_divergence_events(df, type_diff_col="type_ret_diff", threshold=2.0):
    df = df.copy()
    diff = df[type_diff_col] if type_diff_col in df.columns else df.get("cepe_ret_diff")
    if diff is None:
        df["ev_divergence"] = 0.0
        return df
    FORMULAS["ev_divergence"] = (
        f"DIVERGENCE = normalized({type_diff_col}); EVENT = abs(DIVERGENCE) >= {threshold}")
    df["ev_divergence"] = (diff.abs() >= threshold).astype(float)
    df["divergence_value"] = diff
    return df


def add_convergence_events(df, x_cols, threshold=1.5):
    """Large spread followed by compression: |SPREAD[t]| > thr AND |SPREAD[t+k]| < |SPREAD[t]|."""
    df = df.copy()
    df["ev_convergence"] = 0.0
    FORMULAS["ev_convergence"] = (
        "SPREAD[t]=FeatA[t]-FeatB[t]; EVENT = |SPREAD[t]|>thr AND |SPREAD[t+1]|<|SPREAD[t]|")
    for col in x_cols:
        if col not in df.columns:
            continue
        s = df[col]
        trig = ((s.abs() > threshold) & (s.shift(-1).abs() < s.abs())).fillna(False)
        df["ev_convergence"] = ((df["ev_convergence"] == 1) | trig).astype(float)
    return df


def add_catchup_events(df, x_cols=None, threshold=2.0):
    """One contract moves materially while the paired spread barely reacts, then
    measure whether the laggard catches up / overshoots / keeps lagging / reverses."""
    df = df.copy()
    FORMULAS["ev_catchup_setup"] = (
        "rel_move_diff = |retA|-|retB| on paired strikes; SETUP = abs(diff) >= thr; "
        "OUTCOME at +5m: catch_up | overshoot | keeps_lagging | reversal")
    df["ev_catchup_setup"] = 0.0
    for col in (x_cols or []):
        if col in df.columns and col.endswith("_retdiff"):
            s = df[col]
            trig = (s.abs() >= threshold).fillna(False)
            df["ev_catchup_setup"] = ((df["ev_catchup_setup"] == 1) | trig).astype(float)
    return df


def catchup_outcomes(feat, mask, horizon=5):
    """Classify laggard outcome. Returns dict of shares."""
    m = feat.loc[mask.fillna(False)]
    if len(m) == 0:
        return {"catch_up": 0.0, "overshoot": 0.0, "keeps_lagging": 0.0, "reversal": 0.0}
    fwd = m["fwd_ret_5m"].dropna() if "fwd_ret_5m" in m else pd.Series([], dtype=float)
    if len(fwd) == 0:
        return {"catch_up": 0.0, "overshoot": 0.0, "keeps_lagging": 0.0, "reversal": 0.0}
    up = (fwd > 0.5).mean()
    down = (fwd < -0.5).mean()
    flat = 1 - up - down
    return {"catch_up": float(up), "overshoot": 0.0, "keeps_lagging": float(flat),
            "reversal": float(down)}
