"""Deterministic no-lookahead audit (§1-§5). Independently recomputes features and
labels from raw bars; compares with tolerance. Statuses: PASS | FAIL_TRUE_LOOKAHEAD
| FAIL_AUDIT_MISMATCH | INSUFFICIENT_DATA. Abort only on FAIL_TRUE_LOOKAHEAD."""
import numpy as np
import pandas as pd

TOL = 1e-6


def _close(a, b):
    fa, fb = pd.isna(a), pd.isna(b)
    if fa and fb:
        return "both-na"
    if fa or fb:
        return "nan-mismatch"
    d = abs(float(a) - float(b))
    if d <= TOL or d <= TOL * max(1.0, abs(float(a)), abs(float(b))):
        return "ok"
    return "value-mismatch"


def audit_lookahead(feat, H=120, n_samples=10):
    """Deterministic samples: recompute return_1/5, rolling_mean, atr_14,
    volume_zscore (past-only) and fwd_ret_1m (label) from raw bars."""
    tests = []
    groups = list(feat.groupby("symbol").groups.items())
    samples = []
    for _, idx in groups:
        s = feat.loc[idx].sort_values("timestamp").reset_index(drop=True)
        step = max(1, len(s) // 4)
        for i in range(20, len(s) - 16, step):
            if pd.notna(s.loc[i, "return_1"]) and pd.notna(s.loc[i, "fwd_ret_1m"]):
                samples.append((s, i))
                if len(samples) >= n_samples:
                    break
        if len(samples) >= n_samples:
            break
    if not samples:
        return {"status": "INSUFFICIENT_DATA", "feature_tests": 0, "label_tests": 0,
                "spot_pass": 0, "spot_fail": 0, "first_mismatch": "no finite sample rows",
                "tests": []}

    def note(kind, col, prod, indep, smin, smax):
        res = _close(prod, indep)
        tests.append({"kind": kind, "col": col, "prod": prod, "indep": indep,
                      "res": res, "src_min": smin, "src_max": smax})
        return res

    for s, i in samples:
        c = s["close"].values
        note("feature", "return_1", s.loc[i, "return_1"], c[i] / c[i - 1] * 100 - 100, i - 1, i)
        note("feature", "return_5", s.loc[i, "return_5"], c[i] / c[i - 5] * 100 - 100, i - 5, i)
        lo = max(0, i - H)
        win = c[lo:i]
        rm = float(np.mean(win)) if len(win) >= 20 else np.nan
        note("feature", "rolling_mean", s.loc[i, "rolling_mean"], rm, lo, i - 1)
        # NOTE: Python engine defines atr = rolling mean of plain range (high-low);
        # the JS engine uses true-range mean per spec §9. The audit replicates
        # each engine's own documented formula; cross-engine ATR values differ by design.
        rng = s["range"].values
        atrs = rng[max(0, i - 14):i]
        atrs = atrs[~np.isnan(atrs)]
        atr = float(np.mean(atrs)) if len(atrs) >= 5 else np.nan
        note("feature", "atr", s.loc[i, "atr"], atr, max(0, i - 15), i - 1)
        vv = s["volume"].values[lo:i]
        vv = vv[~np.isnan(vv)]
        if len(vv) >= 20:
            # pandas rolling std uses ddof=1 — replicate exactly
            vz = (s.loc[i, "volume"] - vv.mean()) / (vv.std(ddof=1) or np.nan)
        else:
            vz = np.nan
        note("feature", "volume_zscore", s.loc[i, "volume_zscore"], float(vz), lo, i)
        note("label", "fwd_ret_1m", s.loc[i, "fwd_ret_1m"], c[i + 1] / c[i] * 100 - 100, i + 1, i + 1)

    bad = [t for t in tests if t["res"] == "value-mismatch"]
    passed = sum(1 for t in tests if t["res"] == "ok")
    if bad:
        status = "FAIL_TRUE_LOOKAHEAD"
    elif passed == 0:
        status = "INSUFFICIENT_DATA"
    else:
        status = "PASS"
    return {
        "status": status,
        "feature_tests": sum(1 for t in tests if t["kind"] == "feature"),
        "label_tests": sum(1 for t in tests if t["kind"] == "label"),
        "spot_pass": passed, "spot_fail": len(bad),
        "first_mismatch": (f"{bad[0]['col']} prod={bad[0]['prod']} indep={bad[0]['indep']}"
                           if bad else "none"),
        "tests": tests,
    }


def test_no_lookahead(feat, label_cols):
    """Legacy boolean interface (kept for callers): PASS only on clean audit."""
    try:
        r = audit_lookahead(feat)
        return {"leak_cols": [], "spot_check": r["status"] == "PASS",
                "PASS": r["status"] == "PASS", "detail": r}
    except Exception as ex:
        return {"leak_cols": [], "spot_check": False, "PASS": False,
                "detail": {"status": "FAIL_AUDIT_MISMATCH", "error": str(ex)[:200]}}
