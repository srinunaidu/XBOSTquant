"""Data capability map (§2/§3): what the dataset can actually support.
Built per symbol BEFORE discovery. Methods requiring unavailable
capabilities are never attempted (logged as skipped, not failed)."""
import pandas as pd
import numpy as np

AVAILABLE = "AVAILABLE"
PARTIAL = "PARTIAL"
UNAVAILABLE = "UNAVAILABLE"
INSUFFICIENT = "INSUFFICIENT"


def _cov(s, total):
    return round(float(s / max(1, total)), 4)


def build_capability_map(norm: pd.DataFrame, min_events=50) -> dict:
    """norm: single-symbol frame with canonical identity columns."""
    n = len(norm)
    caps = {}
    # identity completeness
    for col in ("symbol_id", "expiry", "strike", "option_type",
                "timestamp", "instrument_id"):
        if col not in norm.columns:
            caps[f"identity:{col}"] = UNAVAILABLE
            continue
        u = norm[col].astype(str)
        bad = int(((u == "UNKNOWN") | (u == "nan") | (u == "")).sum())
        caps[f"identity:{col}"] = AVAILABLE if bad == 0 else (
            PARTIAL if bad / max(1, n) < 0.2 else INSUFFICIENT)
    # price fields
    for col in ("open", "high", "low", "close", "volume", "oi",
                "bid", "ask"):
        if col not in norm.columns:
            caps[f"field:{col}"] = UNAVAILABLE
            continue
        v = pd.to_numeric(norm[col], errors="coerce")
        c = float(v.notna().mean())
        caps[f"field:{col}"] = AVAILABLE if c >= 0.8 else (
            PARTIAL if c >= 0.2 else INSUFFICIENT)
    # cross-contract overlap (§2): shared timestamps across instruments
    try:
        if "instrument_id" in norm.columns and "timestamp" in norm.columns:
            piv = norm.groupby(["timestamp"])["instrument_id"].nunique()
            both = int((piv >= 2).sum())
            caps["overlap:cross_contract"] = AVAILABLE if both >= min_events else (
                PARTIAL if both > 0 else UNAVAILABLE)
            ex = norm.groupby(["timestamp"])["expiry"].nunique()
            xboth = int((ex.astype(str) != "UNKNOWN").sum() and (ex >= 2).sum())
            caps["overlap:cross_expiry"] = AVAILABLE if xboth >= min_events else (
                PARTIAL if xboth > 0 else UNAVAILABLE)
            ot = norm.groupby(["timestamp"])["option_type"].nunique()
            oboth = int((ot >= 2).sum())
            caps["overlap:cepe"] = AVAILABLE if oboth >= min_events else (
                PARTIAL if oboth > 0 else UNAVAILABLE)
    except Exception:
        for k in ("overlap:cross_contract", "overlap:cross_expiry",
                  "overlap:cepe"):
            caps[k] = UNAVAILABLE
    # temporal coverage
    try:
        ts = pd.to_datetime(norm["timestamp"])
        days = ts.dt.date.nunique()
        syms = norm["symbol"].astype(str).nunique() if "symbol" in norm.columns else 0
        per = norm.groupby(norm["symbol"].astype(str)).size() if "symbol" in norm.columns else pd.Series([])
        caps["temporal:rows"] = int(n)
        caps["temporal:sessions"] = int(ts.dt.date.nunique())
        caps["temporal:days"] = int(days)
        caps["temporal:contracts"] = int(syms)
        caps["temporal:rows_per_contract"] = round(float(per.mean()), 1) if len(per) else 0
        caps["temporal:median_obs_per_instrument"] = float(per.median()) if len(per) else 0
        caps["temporal:min_obs_per_instrument"] = int(per.min()) if len(per) else 0
        caps["temporal:max_obs_per_instrument"] = int(per.max()) if len(per) else 0
        gaps = int(ts.sort_values().diff().dt.total_seconds().div(60).gt(30).sum())
        caps["temporal:timestamp_gaps_gt30m"] = gaps
    except Exception:
        pass
    return caps


def capability_matrix(caps: dict) -> list:
    """Printable AVAILABLE/PARTIAL/UNAVAILABLE/INSUFFICIENT rows (§3)."""
    rows = []
    for k in sorted(caps):
        if k.startswith(("identity:", "field:", "overlap:")):
            rows.append({"capability": k, "status": caps[k]})
    return rows


def feature_capability(feat: pd.DataFrame, cols: list) -> pd.DataFrame:
    """Per-feature capability (§2): valid rows, coverage, dispersion,
    usable_for_discovery flag."""
    rows = []
    n = len(feat)
    for c in cols:
        if c not in feat.columns:
            rows.append({"feature": c, "valid_rows": 0, "coverage_pct": 0.0,
                         "unique_values": 0, "variance": "NA", "min": "NA",
                         "max": "NA", "missing_pct": 1.0,
                         "usable_for_discovery": False})
            continue
        s = pd.to_numeric(feat[c], errors="coerce")
        valid = int(s.notna().sum())
        var = float(s.var()) if valid > 1 else 0.0
        rows.append({"feature": c, "valid_rows": valid,
                     "coverage_pct": round(valid / max(1, n), 4),
                     "unique_values": int(s.nunique()),
                     "variance": round(var, 6),
                     "min": round(float(s.min()), 6) if valid else "NA",
                     "max": round(float(s.max()), 6) if valid else "NA",
                     "missing_pct": round(1 - valid / max(1, n), 4),
                     "usable_for_discovery": bool(
                         valid >= 50 and var > 0 and s.nunique() > 2)})
    return pd.DataFrame(rows)


def horizon_eligibility(feat: pd.DataFrame, mask, horizons=(1, 3, 5, 10, 15, 30),
                        min_events=50) -> dict:
    """§5/§6: only activate horizons with sufficient observations.
    Never pad, interpolate, or manufacture observations."""
    out = {}
    m = mask.fillna(False)
    for w in horizons:
        col = f"fwd_ret_{w}m"
        if col not in feat.columns:
            out[w] = {"status": UNAVAILABLE, "eligible_events": 0}
            continue
        v = pd.to_numeric(feat.loc[m, col], errors="coerce").dropna()
        out[w] = {"status": AVAILABLE if len(v) >= min_events else INSUFFICIENT,
                  "eligible_events": int(len(v)),
                  "coverage": round(len(v) / max(1, int(m.sum())), 4),
                  "positive_rate": round(float((v > 0).mean()), 4) if len(v) else "NA",
                  "median_return": round(float(v.median()), 4) if len(v) else "NA",
                  "mean_return": round(float(v.mean()), 4) if len(v) else "NA"}
    return out
