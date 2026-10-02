"""Dataset validator (spec §3) + session validation. No forward-fill, no bar manufacture."""
import pandas as pd
import numpy as np

def validate(norm: pd.DataFrame) -> dict:
    ts = pd.to_datetime(norm["timestamp"])
    uniq = ts.drop_duplicates().sort_values()
    diffs = uniq.diff().dropna()
    total_rows = len(norm)
    n_unique = uniq.nunique()
    dup = int(total_rows - norm.drop_duplicates(
        subset=["timestamp", "strike", "option_type"] ).shape[0])
    # duplicate timestamps (same ts appearing with dup contract rows is normal;
    # here count exact duplicate rows)
    median_iv = diffs.median() if len(diffs) else pd.NaT
    mode_iv = diffs.mode().iloc[0] if len(diffs) else pd.NaT
    max_gap = diffs.max() if len(diffs) else pd.NaT
    # expected 1m intervals within each trading day session
    days = uniq.dt.date
    trading_days = int(days.nunique())
    per_day = uniq.groupby(days).size()
    # missing expected intervals: per day, expected = (last-first)/1min + 1
    missing = 0
    for d, grp in uniq.groupby(days):
        g = grp.sort_values()
        if len(g) < 2:
            continue
        span_min = (g.max() - g.min()).total_seconds() / 60
        expected = int(round(span_min)) + 1
        missing += max(0, expected - len(g))
    contracts = norm.assign(c=norm["strike"].astype(str) + norm["option_type"])["c"].unique().tolist()
    return {
        "total_rows": int(total_rows),
        "unique_timestamps": int(n_unique),
        "duplicate_rows": int(dup),
        "median_interval": str(median_iv),
        "mode_interval": str(mode_iv),
        "maximum_gap": str(max_gap),
        "missing_expected_intervals": int(missing),
        "trading_days": trading_days,
        "obs_per_day": {str(k): int(v) for k, v in per_day.items()},
        "session_start": str(uniq.dt.time.min()),
        "session_end": str(uniq.dt.time.max()),
        "contracts": sorted(contracts),
        "n_contracts": len(contracts),
        "expiries": sorted(norm["expiry"].astype(str).unique().tolist()),
        "ts_min": str(uniq.min()),
        "ts_max": str(uniq.max()),
        "is_1m": (median_iv == pd.Timedelta("1min")) if pd.notna(median_iv) else False,
    }
