"""Return-path discovery (§10/§12/§48). Multi-horizon forward returns + MFE/MAE
path statistics per event. Research classification only — never a profitability
claim from a single event."""
import pandas as pd
import numpy as np

HORIZONS = (1, 3, 5, 10, 15, 30)


def _fwd(feat, w):
    col = f"fwd_ret_{w}m"
    if col in feat.columns:
        return feat[col]
    return pd.Series(np.nan, index=feat.index)


def _mfe(feat, w):
    for c in (f"MFE_{w}m", f"MFE_abs_{w}m"):
        if c in feat.columns:
            return feat[c]
    return pd.Series(np.nan, index=feat.index)


def _mae(feat, w):
    for c in (f"MAE_{w}m", f"MAE_abs_{w}m"):
        if c in feat.columns:
            return feat[c]
    return pd.Series(np.nan, index=feat.index)


def compute_return_path(feat: pd.DataFrame, mask) -> dict:
    """§10/§48 return-path profile for one event mask."""
    m = mask.fillna(False)
    n = int(m.sum())
    out = {"event_count": n, "horizons": {}, "MFE": {}, "MAE": {},
           "time_to_MFE": "NA", "time_to_MAE": "NA",
           "target_first_pct": "NA", "stop_first_pct": "NA"}
    if n == 0:
        return out
    for w in HORIZONS:
        v = pd.to_numeric(_fwd(feat, w).loc[m], errors="coerce").dropna()
        out["horizons"][w] = {
            "mean": round(float(v.mean()), 4) if len(v) else "NA",
            "median": round(float(v.median()), 4) if len(v) else "NA",
            "WR": round(float((v > 0).mean()), 4) if len(v) else "NA",
            "n": int(len(v))}
    mfe_vals = {w: pd.to_numeric(_mfe(feat, w).loc[m], errors="coerce").dropna()
                for w in HORIZONS}
    mae_vals = {w: pd.to_numeric(_mae(feat, w).loc[m], errors="coerce").dropna()
                for w in HORIZONS}
    for name, vals in (("MFE", mfe_vals), ("MAE", mae_vals)):
        allv = pd.concat([v for v in vals.values() if len(v)]) \
            if any(len(v) for v in vals.values()) else pd.Series([], dtype=float)
        out[name] = {"mean": round(float(allv.mean()), 4) if len(allv) else "NA",
                     "median": round(float(allv.median()), 4) if len(allv) else "NA",
                     "P90": round(float(allv.quantile(0.9)), 4) if len(allv) else "NA"}
    # time-to-extremes: first horizon attaining max median MFE / MAE
    try:
        meds = {w: (float(mfe_vals[w].median()) if len(mfe_vals[w]) else float("nan"))
                for w in HORIZONS}
        best = max(meds, key=lambda w: meds[w] if meds[w] == meds[w] else -1e18)
        out["time_to_MFE"] = int(best) if meds[best] == meds[best] else "NA"
    except Exception:
        pass
    try:
        meds = {w: (float(mae_vals[w].median()) if len(mae_vals[w]) else float("nan"))
                for w in HORIZONS}
        best = max(meds, key=lambda w: meds[w] if meds[w] == meds[w] else -1e18)
        out["time_to_MAE"] = int(best) if meds[best] == meds[best] else "NA"
    except Exception:
        pass
    return out


def first_touch_stats(feat: pd.DataFrame, mask, sl_pct=0.5,
                      tp_pct=1.0, hold=5) -> dict:
    """Percentage reaching target/stop first within hold window (§12)."""
    from .backtest import backtest
    try:
        led = backtest(feat, mask, hold_bars=int(hold), sl=float(sl_pct),
                       tp=float(tp_pct), exit_mode="premium",
                       cid="PATHTOUCH", verify=False)
    except Exception:
        return {"target_first_pct": "NA", "stop_first_pct": "NA",
                "time_only_pct": "NA"}
    if len(led) == 0:
        return {"target_first_pct": "NA", "stop_first_pct": "NA",
                "time_only_pct": "NA"}
    return {"target_first_pct": round(float((led["exit_reason"] == "TP").mean()), 4),
            "stop_first_pct": round(float((led["exit_reason"] == "SL").mean()), 4),
            "time_only_pct": round(float((led["exit_reason"] == "TIME").mean()), 4)}


def classify_path(profile: dict) -> str:
    """§12 research classification from the return-path profile."""
    h = profile.get("horizons", {})
    try:
        m = {w: h[w]["mean"] for w in HORIZONS
             if isinstance(h.get(w, {}).get("mean"), (int, float))}
    except Exception:
        return "NOISE"
    if not m:
        return "NOISE"
    vals = [m[w] for w in sorted(m)]
    if all(v <= 0 for v in vals):
        return "NOISE"
    peak_w = max(m, key=lambda w: m[w])
    last_w = max(m)
    peak = m[peak_w]
    last = m[last_w]
    if peak_w in (1, 3) and last < 0.3 * peak:
        return "FAST_SPIKE"
    if peak_w in (10, 15, 30) and last > 0.7 * peak:
        return "SLOW_BURN"
    if last < 0 and peak > 0:
        return "MEAN_REVERSION"
    if profile.get("target_first_pct") not in ("NA", None):
        try:
            if float(profile["target_first_pct"]) > 0.5:
                return "TARGET_FIRST"
            if float(profile["stop_first_pct"]) > 0.5:
                return "STOP_FIRST"
        except Exception:
            pass
    if last > 0 and last >= 0.5 * peak:
        return "SLOW_BURN"
    return "NOISE"
