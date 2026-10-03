"""Feature missingness tiers (§8). No silent imputation of large missing blocks.

Tiers by missing fraction:
  0-20% FULL | 20-40% LIMITED | 40-60% WEAK | 60-80% RESTRICTED | >80% DISABLED
"""
import pandas as pd
import numpy as np


def tier_of(missing_fraction: float) -> str:
    m = float(missing_fraction)
    if m <= 0.20:
        return "FULL"
    if m <= 0.40:
        return "LIMITED"
    if m <= 0.60:
        return "WEAK"
    if m <= 0.80:
        return "RESTRICTED"
    return "DISABLED"


def allowed_use(tier: str, depth: int, is_primary: bool) -> bool:
    """DISABLED never generates a candidate. RESTRICTED never primary.
    WEAK only in controlled combinations (depth>=2)."""
    if tier == "DISABLED":
        return False
    if tier == "RESTRICTED" and is_primary and depth <= 1:
        return False
    if tier == "WEAK" and depth < 2:
        return False
    return True


def audit_features(feat: pd.DataFrame, cols: list) -> pd.DataFrame:
    """Per-feature missingness audit (§8 log fields)."""
    rows = []
    by_day = feat["day"] if "day" in feat.columns else None
    for c in cols:
        if c not in feat.columns:
            rows.append({"feature": c, "missing_fraction": 1.0, "tier": "DISABLED",
                         "usable_event_count": 0, "note": "column absent"})
            continue
        s = feat[c]
        miss = float(s.isna().mean()) if len(s) else 1.0
        usable = int(s.notna().sum())
        entry = {"feature": c, "missing_fraction": round(miss, 4),
                 "tier": tier_of(miss), "usable_event_count": usable}
        if by_day is not None:
            try:
                mbd = s.isna().groupby(feat["day"]).mean()
                entry["worst_day_missing"] = round(float(mbd.max()), 4)
            except Exception:
                entry["worst_day_missing"] = "NA"
        if "symbol" in feat.columns:
            try:
                mbs = s.isna().groupby(feat["symbol"]).mean()
                entry["worst_contract_missing"] = round(float(mbs.max()), 4)
            except Exception:
                entry["worst_contract_missing"] = "NA"
        if "expiry" in feat.columns:
            try:
                mbe = s.isna().groupby(feat["expiry"].astype(str)).mean()
                entry["worst_expiry_missing"] = round(float(mbe.max()), 4)
            except Exception:
                entry["worst_expiry_missing"] = "NA"
        rows.append(entry)
    return pd.DataFrame(rows)
