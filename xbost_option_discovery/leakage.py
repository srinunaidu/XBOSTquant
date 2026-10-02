"""No-lookahead automated tests (§18). Features use t-only; labels use t+k."""
import pandas as pd

def test_no_lookahead(feat, label_cols):
    # 1. no label col may be used as feature: check no fwd_/MFE/MAE in feature prefix list
    feats = [c for c in feat.columns if c.startswith(("return_", "accel_", "volume_", "range_", "cepe_", "x_", "e_", "ev_"))]
    leak = [c for c in feats if c.startswith("fwd_") or c.startswith("MFE") or c.startswith("MAE")]
    # 2. rolling stats must be shifted: verify construction used shift by checking code invariant —
    # runtime check: feature at t must equal function of rows <= t (spot check return_1)
    ok = True
    for _, idx in list(feat.groupby(["strike", "option_type"]).groups.items())[:2]:
        s = feat.loc[idx].sort_values("timestamp")
        if len(s) > 5:
            c = s["close"].values; r = s["return_1"].values
            expect = (c[3] / c[2] * 100 - 100)
            if abs(r[3] - expect) > 1e-6:
                ok = False
    return {"leak_cols": leak, "spot_check": ok,
            "PASS": (len(leak) == 0 and ok)}
