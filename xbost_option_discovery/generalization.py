"""Generalization battery (§15-§20): contract/strike/expiry/otype/time/regime.

Every test returns PASS / FAIL / UNTESTABLE with an explicit reason.
UNTESTABLE is never converted into a fake passing score. No silent fallback:
when a required input is missing the test reports NOT_AVAILABLE/SKIPPED.
"""
import pandas as pd
import numpy as np


def _fwd_expectancy(feat, mask):
    v = pd.to_numeric(feat.loc[mask.fillna(False), "fwd_ret_5m"],
                      errors="coerce").dropna()
    if len(v) < 5:
        return float("nan"), 0
    return float(v.mean()), int(len(v))


def _verdict(frac, min_frac=0.5, min_n=2):
    if frac != frac:
        return "UNTESTABLE"
    return "PASS" if frac >= min_frac else "FAIL"


def contract_generalization(feat, mask):
    """§15: per-contract expectancy breadth. Works on any discovered symbols."""
    if "symbol" not in feat.columns:
        return {"status": "UNTESTABLE", "reason": "no symbol column",
                "contract_count": 0}
    m = mask.fillna(False)
    contracts = feat.loc[m, "symbol"].dropna().unique().tolist()
    if len(contracts) < 2:
        return {"status": "UNTESTABLE", "reason": "no contract variation",
                "contract_count": int(len(contracts))}
    pos, rows = 0, []
    for c in contracts:
        e, n = _fwd_expectancy(feat, m & (feat["symbol"] == c))
        ok = pd.notna(e) and e > 0
        pos += int(ok)
        rows.append({"contract": str(c), "expectancy": e, "n": n,
                     "positive": bool(ok)})
    frac = pos / max(1, len(rows))
    exps = [r["expectancy"] for r in rows if pd.notna(r["expectancy"])]
    return {"status": _verdict(frac), "reason": f"{pos}/{len(rows)} positive",
            "contract_count": len(contracts),
            "positive_contract_count": pos,
            "positive_fraction": round(frac, 4),
            "median_contract_expectancy": round(float(np.median(exps)), 4) if exps else "NA",
            "worst_contract": min(rows, key=lambda r: (r["expectancy"] if pd.notna(r["expectancy"]) else 1e18)),
            "best_contract": max(rows, key=lambda r: (r["expectancy"] if pd.notna(r["expectancy"]) else -1e18)),
            "by_contract": rows}


def _group_test(feat, mask, col, min_groups=2):
    if col not in feat.columns:
        return {"status": "UNTESTABLE", "reason": f"no {col} column"}
    m = mask.fillna(False)
    try:
        groups = feat.loc[m, col].astype(str).unique().tolist()
    except Exception:
        return {"status": "UNTESTABLE", "reason": f"unreadable {col}"}
    groups = [g for g in groups if g not in ("nan", "None", "UNKNOWN", "")]
    if len(groups) < min_groups:
        return {"status": "UNTESTABLE",
                "reason": f"no {col} variation ({len(groups)} group)"}
    pos, rows = 0, []
    for g in groups:
        e, n = _fwd_expectancy(feat, m & (feat[col].astype(str) == g))
        ok = pd.notna(e) and e > 0
        pos += int(ok)
        rows.append({"group": str(g), "expectancy": e, "n": n,
                     "positive": bool(ok)})
    frac = pos / max(1, len(rows))
    signs = [1 if (pd.notna(r["expectancy"]) and r["expectancy"] > 0) else -1
             for r in rows]
    agree = len(set(signs)) == 1
    return {"status": _verdict(frac), "reason": f"{pos}/{len(rows)} positive",
            "positive_fraction": round(frac, 4),
            "sign_agreement": bool(agree), "by_group": rows}


def strike_robustness(feat, mask):
    r = _group_test(feat, mask, "strike")
    r["dimension"] = "strike"
    return r


def expiry_robustness(feat, mask):
    r = _group_test(feat, mask, "expiry")
    r["dimension"] = "expiry"
    return r


def otype_robustness(feat, mask):
    """CE/PE robustness over whatever option types the data discovered."""
    r = _group_test(feat, mask, "option_type")
    r["dimension"] = "option_type"
    return r


def time_robustness(feat, mask):
    """§19: observed-session time buckets (quantile windows, no hardcoded clock)."""
    from .robustness import session_windows
    if "timestamp" not in feat.columns:
        return {"status": "UNTESTABLE", "reason": "no timestamp column"}
    try:
        wins = session_windows(feat, mask.fillna(False), n_windows=4)
    except Exception as e:
        return {"status": "UNTESTABLE", "reason": f"window build failed: {e}"}
    if not wins:
        return {"status": "UNTESTABLE", "reason": "no events"}
    t = pd.to_datetime(feat.loc[mask.fillna(False), "timestamp"]).dt.strftime("%H:%M")
    pos, rows = 0, []
    for name, a, b in wins:
        subm = mask.fillna(False) & t.between(a, b).reindex(feat.index, fill_value=False)
        e, n = _fwd_expectancy(feat, subm)
        ok = pd.notna(e) and e > 0
        pos += int(ok)
        rows.append({"window": name, "expectancy": e, "n": n,
                     "positive": bool(ok)})
    frac = pos / max(1, len(rows))
    return {"status": _verdict(frac), "reason": f"{pos}/{len(rows)} windows positive",
            "dimension": "time", "positive_fraction": round(frac, 4),
            "by_group": rows}


def regime_robustness(feat, mask):
    """§20: option-native regimes (no underlying required)."""
    col = None
    for c in ("b_vol_regime", "b_vol", "range_expansion", "volume_percentile"):
        if c in feat.columns:
            col = c
            break
    if col is None:
        return {"status": "UNTESTABLE", "reason": "no regime column available"}
    m = mask.fillna(False)
    try:
        if col in ("range_expansion", "volume_percentile"):
            s = pd.to_numeric(feat[col], errors="coerce")
            q = s.loc[m].quantile([0.33, 0.67])
            lab = pd.cut(s, bins=[-np.inf, q.iloc[0], q.iloc[1], np.inf],
                         labels=["low", "normal", "high"])
        else:
            lab = feat[col].astype(str)
    except Exception as e:
        return {"status": "UNTESTABLE", "reason": f"regime split failed: {e}"}
    groups = [g for g in pd.Series(lab).dropna().unique().tolist() if str(g) != "nan"]
    if len(groups) < 2:
        return {"status": "UNTESTABLE", "reason": "no regime variation"}
    pos, rows = 0, []
    for g in groups:
        gm = m & (pd.Series(lab, index=feat.index) == g).fillna(False).values
        e, n = _fwd_expectancy(feat, pd.Series(gm, index=feat.index))
        ok = pd.notna(e) and e > 0
        pos += int(ok)
        rows.append({"group": str(g), "expectancy": e, "n": n,
                     "positive": bool(ok)})
    frac = pos / max(1, len(rows))
    return {"status": _verdict(frac), "reason": f"{pos}/{len(rows)} regimes positive",
            "dimension": "regime", "regime_column": col,
            "positive_fraction": round(frac, 4), "by_group": rows}
