"""Adaptive staged exit discovery (§11). Uses discovery+refinement ONLY — never OOS.

Stage A: holding period only → Stage B: +stop → Stage C: +target → Stage D: +trail.
Promote a stage only on genuine validation improvement. Iterative, bounded.
"""
import pandas as pd
import numpy as np


def _atr_pct(feat, mask):
    """Median ATR as % of close for ATR-derived stops/targets (§12)."""
    import pandas as pd
    if "atr" not in feat.columns:
        return None
    v = pd.to_numeric(
        (feat.loc[mask.fillna(False), "atr"]
         / feat.loc[mask.fillna(False), "close"] * 100),
        errors="coerce").dropna()
    v = v[(v > 0) & (v < 50)]
    return float(v.median()) if len(v) else None


def _val_expectancy(feat, mask, val_days, hold, sl, tp, trail=None):
    from .backtest import backtest
    from .metrics import calculate_trade_metrics
    m = mask.fillna(False) & feat["day"].isin(val_days)
    if m.sum() < 10:
        return float("nan"), 0
    try:
        led = backtest(feat, m, hold_bars=int(hold), sl=float(sl),
                       tp=float(tp),
                       trail=None if trail is None else float(trail),
                       exit_mode="premium", cid="EXITSEARCH", verify=False)
    except Exception:
        return float("nan"), 0
    if len(led) == 0:
        return float("nan"), 0
    met = calculate_trade_metrics(led)
    return met["expectancy"], len(led)


def discover_exits(feat, mask, val_days, hold_grid, stop_grid,
                   target_grid, trail_grid, min_improve=0.0):
    """Bounded staged search. Returns (best_config, stages_log)."""
    stages = []
    best = {"hold": 5, "sl": 0.5, "tp": 1.0, "trail": None}
    base_exp, base_n = _val_expectancy(feat, mask, val_days, 5, 0.5, 1.0)
    stages.append({"stage": "A_base", "config": dict(best),
                   "val_expectancy": base_exp, "n": base_n})
    # Stage A: holding period only (time exit: wide sl/tp)
    best_a, best_a_exp = int(best["hold"]), base_exp
    for h in hold_grid:
        e, _ = _val_expectancy(feat, mask, val_days, h, 99.0, 99.0)
        if pd.notna(e) and (pd.isna(best_a_exp) or e > best_a_exp + min_improve):
            best_a, best_a_exp = int(h), e
    stages.append({"stage": "A_hold", "config": {"hold": best_a},
                   "val_expectancy": best_a_exp})
    if pd.notna(best_a_exp) and (pd.isna(base_exp) or best_a_exp > base_exp + min_improve):
        best["hold"] = best_a
    # Stage B: + stop (fixed grid, then ATR-derived candidates §12)
    best_sl, best_b_exp = float(best["sl"]), base_exp
    for sl in stop_grid:
        e, _ = _val_expectancy(feat, mask, val_days, best["hold"], sl, 99.0)
        if pd.notna(e) and (pd.isna(best_b_exp) or e > best_b_exp + min_improve):
            best_sl, best_b_exp = float(sl), e
    atr_pct = _atr_pct(feat, mask)
    atr_note = None
    if atr_pct:
        for mult in (0.5, 1.0, 1.5):
            sl_atr = round(mult * atr_pct, 3)
            e, _ = _val_expectancy(feat, mask, val_days, best["hold"], sl_atr, 99.0)
            if pd.notna(e) and (pd.isna(best_b_exp) or e > best_b_exp + min_improve):
                best_sl, best_b_exp = float(sl_atr), e
                atr_note = f"ATRxsl{mult}"
    stages.append({"stage": "B_stop", "config": {"hold": best["hold"], "sl": best_sl,
                                                 "sl_source": atr_note or "fixed"},
                   "val_expectancy": best_b_exp})
    if pd.notna(best_b_exp) and (pd.isna(base_exp) or best_b_exp > base_exp + min_improve):
        best["sl"] = best_sl
    # Stage C: + target
    best_tp, best_c_exp = float(best["tp"]), best_b_exp
    for tp in target_grid:
        e, _ = _val_expectancy(feat, mask, val_days, best["hold"], best["sl"], tp)
        if pd.notna(e) and (pd.isna(best_c_exp) or e > best_c_exp + min_improve):
            best_tp, best_c_exp = float(tp), e
    stages.append({"stage": "C_target",
                   "config": {"hold": best["hold"], "sl": best["sl"], "tp": best_tp},
                   "val_expectancy": best_c_exp})
    if pd.notna(best_c_exp) and (pd.isna(base_exp) or best_c_exp > base_exp + min_improve):
        best["tp"] = best_tp
    else:
        best_c_exp = best_b_exp
    # Stage D: + trail (fixed grid + breakeven: trail activates at
    # entry so any give-back exits flat — approximated by tight trail)
    best_tr, best_d_exp = None, best_c_exp
    for tr in list(trail_grid) + ([0.05] if 0.05 not in list(trail_grid) else []):
        e, _ = _val_expectancy(feat, mask, val_days, best["hold"], best["sl"],
                               best["tp"], trail=tr)
        if pd.notna(e) and (pd.isna(best_d_exp) or e > best_d_exp + min_improve):
            best_tr, best_d_exp = float(tr), e
    stages.append({"stage": "D_trail",
                   "config": {"hold": best["hold"], "sl": best["sl"],
                              "tp": best["tp"], "trail": best_tr,
                              "breakeven_candidate": 0.05},
                   "val_expectancy": best_d_exp})
    if best_tr is not None and pd.notna(best_d_exp) and \
            (pd.isna(base_exp) or best_d_exp > base_exp + min_improve):
        best["trail"] = best_tr
    improved = pd.notna(best_d_exp) and pd.notna(base_exp) and best_d_exp > base_exp
    return {"best": best, "stages": stages,
            "base_val_expectancy": base_exp,
            "best_val_expectancy": best_d_exp if pd.notna(best_d_exp) else base_exp,
            "improved": bool(improved)}
