"""OPTION_EXIT_DISCOVERY (§3/§4/§5): first-class exit research module.

Runs automatically for every sufficiently promising entry hypothesis.
Families:
  STOP:   NONE | FIXED_PERCENT | ATR | VOLATILITY | MAE_DERIVED
  TARGET: NONE | FIXED_PERCENT | ATR | VOLATILITY | MFE_DERIVED
  TRAIL:  NONE | FIXED_PERCENT | ATR | MFE_BASED | BREAKEVEN | DELAYED_TRAIL
          | PROFIT_GATED_TRAIL
  TIME:   holds grid (bars)

Combinations STOP x TARGET x TRAIL x TIME are evaluated in a staged,
return-path-guided, bounded search. Invalid combos are excluded AND logged —
never silently reduced. Every tested variant increments GLOBAL_TEST_COUNT.
OOS is NEVER touched here (validation only); the matrix OOS column is filled
exclusively by the locked final rule evaluation.
"""
import pandas as pd
import numpy as np

EXIT_AUDIT = {"generated": 0, "evaluated": 0, "rejected": 0, "untestable": 0,
              "excluded_invalid": 0, "matrix": [], "families": set(),
              "stop_values": set(), "target_values": set(),
              "trail_values": set(), "holds": set()}


def reset_audit():
    global EXIT_AUDIT
    EXIT_AUDIT = {"generated": 0, "evaluated": 0, "rejected": 0,
                  "untestable": 0, "excluded_invalid": 0, "matrix": [],
                  "families": set(), "stop_values": set(),
                  "target_values": set(), "trail_values": set(),
                  "holds": set()}


def _atr_pct(feat, mask):
    if "atr" not in feat.columns:
        return None
    v = pd.to_numeric(
        (feat.loc[mask.fillna(False), "atr"]
         / feat.loc[mask.fillna(False), "close"] * 100),
        errors="coerce").dropna()
    v = v[(v > 0) & (v < 50)]
    return float(v.median()) if len(v) else None


def _path_levels(rpath):
    """MAE/MFE-derived data-adaptive levels from the return-path profile."""
    def _num(x):
        try:
            v = float(x)
            return v if v == v and v > 0 else None
        except (TypeError, ValueError):
            return None
    mae = _num((rpath.get("MAE") or {}).get("median"))
    mfe = _num((rpath.get("MFE") or {}).get("median"))
    return mae, mfe


def _val_expectancy(feat, mask, val_days, hold, sl, tp, trail_cfg=None,
                    stop_type="FIXED_PERCENT", target_type="FIXED_PERCENT",
                    trail_type="NONE"):
    from .backtest import backtest
    from .metrics import calculate_trade_metrics
    m = mask.fillna(False) & feat["day"].isin(val_days)
    if m.sum() < 10:
        return float("nan"), 0
    try:
        led = backtest(feat, m, hold_bars=int(hold), sl=float(sl),
                       tp=float(tp), trail=None, trail_cfg=trail_cfg,
                       stop_type=stop_type, target_type=target_type,
                       trail_type=trail_type,
                       exit_mode="premium", cid="EXITSEARCH", verify=False)
    except Exception:
        return float("nan"), 0
    if len(led) == 0:
        return float("nan"), 0
    met = calculate_trade_metrics(led)
    return met["expectancy"], len(led)


def _invalid_combo(stop_t, target_t, trail_c, hold):
    """Invalid combinations are excluded AND logged (§4)."""
    if trail_c.get("kind") == "delayed" and trail_c.get("delay", 0) >= hold:
        return "delayed-trail delay >= hold (never activates)"
    gate = trail_c.get("profit_gate")
    if trail_c.get("kind") == "profit_gated" and gate is not None:
        try:
            if target_t != "NONE" and float(gate) >= float(trail_c.get("_tp", 1e18)):
                return "profit gate >= target (trail never activates pre-TP)"
        except (TypeError, ValueError):
            pass
    return ""


def discover_exits(feat, mask, val_days, settings, rpath, registry):
    """Bounded staged combination search (§4/§5/§6).

    Stage A: TIME only. Stage B: +STOP (fixed, ATR, MAE-derived, none).
    Stage C: +TARGET (fixed, ATR, MFE-derived, none). Stage D: +TRAIL
    (none, fixed, ATR, breakeven, delayed, profit-gated). Return-path
    guidance orders candidates; cap enforced; every evaluation counted.
    Returns {best, stages, matrix, audit, improved, exit_status}.
    """
    stages, matrix = [], []
    excluded = []
    cap = int(getattr(settings, "max_exit_combos_per_entry", 40))
    n_eval = [0]

    def _try(stop_t, stop_v, target_t, target_v, trail_c, trail_t, hold):
        if n_eval[0] >= cap:
            return float("nan"), 0, "CAPPED"
        why_bad = _invalid_combo(stop_t, target_t,
                                 dict(trail_c, _tp=target_v), hold)
        if why_bad:
            EXIT_AUDIT["excluded_invalid"] += 1
            excluded.append({"stop": stop_t, "target": target_t,
                             "trail": trail_t, "hold": hold,
                             "reason": why_bad})
            return float("nan"), 0, "EXCLUDED_INVALID"
        EXIT_AUDIT["generated"] += 1
        EXIT_AUDIT["families"].update([stop_t, target_t, trail_t])
        EXIT_AUDIT["holds"].add(int(hold))
        e, n = _val_expectancy(feat, mask, val_days, hold, stop_v, target_v,
                               trail_cfg=trail_c if trail_c.get("kind") != "none" else None,
                               stop_type=stop_t, target_type=target_t,
                               trail_type=trail_t)
        EXIT_AUDIT["evaluated"] += 1
        n_eval[0] += 1
        registry.count_test(1)
        matrix.append({"stop": stop_t, "stop_v": stop_v, "target": target_t,
                       "target_v": target_v, "trail": trail_t,
                       "trail_cfg": str(trail_c), "hold": int(hold),
                       "tested": True, "trades": int(n),
                       "train_exp": "NA", "val_exp": round(float(e), 4)
                       if e == e else "NA",
                       "oos_exp": "NOT_TESTED(FROZEN)"})
        EXIT_AUDIT["matrix"].append(matrix[-1])
        return e, n, "OK"

    mae_med, mfe_med = _path_levels(rpath or {})
    atr = _atr_pct(feat, mask)
    holds = list(getattr(settings, "hold_grid",
                         (1, 2, 3, 5, 8, 10, 15, 20, 30)))
    stop_fixed = list(getattr(settings, "stop_pct_grid", (0.25, 0.5, 1.0, 1.5)))
    targ_fixed = list(getattr(settings, "target_pct_grid", (0.5, 1.0, 2.0, 3.0)))
    atr_sm = list(getattr(settings, "atr_stop_mults", (0.5, 1.0, 1.5)))
    atr_tm = list(getattr(settings, "atr_target_mults", (0.5, 1.0, 1.5)))
    trails = list(getattr(settings, "trail_values", (0.5, 1.0)))
    be_trigs = list(getattr(settings, "breakeven_triggers", (0.3, 0.5)))
    delays = list(getattr(settings, "trail_delays", (2, 3)))
    gates = list(getattr(settings, "profit_gates", (0.5, 1.0)))
    base = {"hold": 5, "sl": 0.5, "tp": 1.0, "trail_cfg": {"kind": "none"},
            "stop_type": "FIXED_PERCENT", "target_type": "FIXED_PERCENT",
            "trail_type": "NONE"}
    base_exp, _ = _val_expectancy(feat, mask, val_days, 5, 0.5, 1.0)
    stages.append({"stage": "A_base_baseline", "config": "SL=.5/TP=1/hold=5 (BASELINE ONLY)",
                   "val_expectancy": base_exp})
    best = dict(base)
    best_exp = base_exp
    # Stage A: TIME only
    for h in holds:
        e, _, _ = _try("NONE", 99.0, "NONE", 99.0, {"kind": "none"}, "NONE", h)
        if pd.notna(e) and (pd.isna(best_exp) or e > best_exp):
            best_exp = e
            best = dict(base, hold=int(h), sl=99.0, tp=99.0,
                        stop_type="NONE", target_type="NONE")
    stages.append({"stage": "A_hold", "val_expectancy": best_exp,
                   "config": f"hold={best['hold']} (time-only)"})
    # Stage B: STOP candidates (fixed, ATR, MAE-derived, none)
    stop_cands = [("FIXED_PERCENT", float(s)) for s in stop_fixed]
    if atr:
        stop_cands += [("ATR", round(m * atr, 3)) for m in atr_sm]
        stop_cands += [("VOLATILITY", round(m * atr, 3)) for m in atr_sm[:2]]
    if mae_med:
        stop_cands.append(("MAE_DERIVED", round(mae_med, 3)))
    stop_cands.append(("NONE", 99.0))
    best_sl, best_sl_t = float(best["sl"]), best["stop_type"]
    for st, sv in stop_cands:
        e, _, _ = _try(st, sv, "NONE", 99.0, {"kind": "none"}, "NONE",
                       best["hold"])
        if pd.notna(e) and (pd.isna(best_exp) or e > best_exp):
            best_exp, best_sl, best_sl_t = e, float(sv), st
    if pd.notna(best_exp) and (pd.isna(base_exp) or best_exp > base_exp):
        best["sl"], best["stop_type"] = best_sl, best_sl_t
    stages.append({"stage": "B_stop", "val_expectancy": best_exp,
                   "config": f"hold={best['hold']} stop={best_sl_t}:{best_sl}"})
    # Stage C: TARGET candidates (fixed, ATR, MFE-derived, none)
    targ_cands = [("FIXED_PERCENT", float(t)) for t in targ_fixed]
    if atr:
        targ_cands += [("ATR", round(m * atr, 3)) for m in atr_tm]
        targ_cands += [("VOLATILITY", round(m * atr, 3)) for m in atr_tm[:2]]
    if mfe_med:
        targ_cands.append(("MFE_DERIVED", round(mfe_med, 3)))
    targ_cands.append(("NONE", 99.0))
    best_tp, best_tp_t = float(best["tp"]), best["target_type"]
    for tt, tv in targ_cands:
        e, _, _ = _try(best["stop_type"], best["sl"], tt, tv,
                       {"kind": "none"}, "NONE", best["hold"])
        if pd.notna(e) and (pd.isna(best_exp) or e > best_exp):
            best_exp, best_tp, best_tp_t = e, float(tv), tt
    if pd.notna(best_exp) and (pd.isna(base_exp) or best_exp > base_exp):
        best["tp"], best["target_type"] = best_tp, best_tp_t
    stages.append({"stage": "C_target", "val_expectancy": best_exp,
                   "config": f"hold={best['hold']} stop={best['stop_type']}:{best['sl']} "
                             f"target={best['target_type']}:{best['tp']}"})
    # Stage D: TRAIL combinations (none/fixed/ATR/MFE/breakeven/delayed/gated).
    # Round-robin by family so every trail structure gets coverage within
    # the per-entry cap (no silent family starvation).
    _groups = [[({"kind": "none"}, "NONE")],
               [({"kind": "fixed", "value": float(t)}, "FIXED_PERCENT")
                for t in trails],
               [({"kind": "breakeven", "trigger": float(trig)}, "BREAKEVEN")
                for trig in be_trigs],
               [({"kind": "delayed", "value": trails[0], "delay": int(dl)},
                 "DELAYED_TRAIL") for dl in delays if dl < best["hold"]],
               [({"kind": "profit_gated", "value": trails[0],
                  "profit_gate": float(g)}, "PROFIT_GATED_TRAIL")
                for g in gates]]
    if atr:
        _groups.append([({"kind": "fixed", "value": round(m * atr, 3)}, "ATR")
                        for m in atr_sm[:2]])
    if mfe_med:
        _groups.append([({"kind": "fixed", "value": round(mfe_med / 2, 3)},
                         "MFE_BASED")])
    trail_cands = []
    for _round in zip(*[_g + [None] * (max(len(_g) for _g in _groups) - len(_g))
                        for _g in _groups]):
        for _tc in _round:
            if _tc is not None:
                trail_cands.append(_tc)
    best_tc, best_tt = dict(best["trail_cfg"]), best["trail_type"]
    for tc, tt in trail_cands:
        e, _, _ = _try(best["stop_type"], best["sl"], best["target_type"],
                       best["tp"], tc, tt, best["hold"])
        if pd.notna(e) and (pd.isna(best_exp) or e > best_exp):
            best_exp, best_tc, best_tt = e, dict(tc), tt
    if pd.notna(best_exp) and (pd.isna(base_exp) or best_exp > base_exp):
        best["trail_cfg"], best["trail_type"] = best_tc, best_tt
    stages.append({"stage": "D_trail", "val_expectancy": best_exp,
                   "config": f"trail={best['trail_type']}:{best['trail_cfg']}"})
    improved = (pd.notna(best_exp) and pd.notna(base_exp)
                and best_exp > base_exp)
    exit_status = ("DISCOVERED" if improved else "BASELINE_KEPT")
    if not pd.notna(base_exp):
        exit_status = "FAILED" if not improved else "DISCOVERED"
    return {"best": best, "stages": stages, "matrix": matrix,
            "excluded_invalid": excluded,
            "base_val_expectancy": base_exp,
            "best_val_expectancy": best_exp if pd.notna(best_exp) else base_exp,
            "improved": bool(improved), "exit_status": exit_status,
            "n_combos_evaluated": n_eval[0]}
