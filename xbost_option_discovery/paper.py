"""Paper eligibility gate + deployable strategy spec (P1).

The gate is DERIVED from measured evidence, never hardcoded. Previously the whole
promotion path was dead: reporting.paper_gate() had three NO-branches and zero
YES-branches, run.py wrote `PAPER_ELIGIBLE = "FALSE"` literally, and a unit test
asserted it stayed false. No amount of evidence could promote a strategy.

`evaluate` returns every check with its measured value so a run can explain exactly
which dimension blocked promotion. `strategy_spec` emits the machine-readable
contract a paper runner consumes - this is the artifact that turns a discovery run
into something deployable.
"""
import datetime as _dt
import json

HARD = "HARD"
SOFT = "SOFT"


def _g(row, key, default=float("nan")):
    v = row.get(key, default) if hasattr(row, "get") else default
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return float("nan")


def evaluate(row, settings, cost_model=None, data_days=None, execution_model=None,
             lookahead_ok=True, metric_integrity="PASS", n_oos_events=None):
    """Evidence-based paper gate. Returns {eligible, reasons, warnings, checks}."""
    checks = []

    def add(name, ok, detail, level=HARD):
        checks.append({"check": name, "passed": bool(ok), "detail": detail, "level": level})
        return bool(ok)

    cost_mode = str(getattr(settings, "cost_mode", "ZERO")).upper()
    cost_real = cost_mode != "ZERO" and cost_model is not None
    if cost_real:
        probe = cost_model.round_trip_pct(100.0, getattr(cost_model, "lot_size", None))
        try:
            cost_real = float(probe) > 0
        except (TypeError, ValueError):
            cost_real = False
        add("cost_model_real", cost_real,
            f"cost_mode={cost_mode} round_trip@100={probe}")
    else:
        add("cost_model_real", False, f"cost_mode={cost_mode} (zero cost cannot be traded)")

    add("lookahead_pass", lookahead_ok, f"NO_LOOKAHEAD={'PASS' if lookahead_ok else 'FAIL'}")
    add("metric_integrity", metric_integrity == "PASS", f"METRIC_INTEGRITY={metric_integrity}")

    exp_is = _g(row, "IS_expectancy")
    add("is_net_expectancy_positive", exp_is > 0, f"IS_expectancy(net)={exp_is:.4f}")

    oos_n = _g(row, "OOS_events") if n_oos_events is None else float(n_oos_events)
    min_oos = float(getattr(settings, "paper_min_oos_events", 20))
    add("oos_sample_size", oos_n >= min_oos, f"OOS_events={oos_n:.0f} >= {min_oos:.0f}")

    exp_oos = _g(row, "FWD_OOS_expectancy")
    add("oos_expectancy_positive", exp_oos > 0, f"FWD_OOS_expectancy={exp_oos:.4f}")

    padj = _g(row, "perm_p_adj")
    max_p = float(getattr(settings, "paper_max_padj", 0.10))
    add("multiple_testing", padj < max_p, f"perm_p_adj={padj:.4f} < {max_p}")

    rob = _g(row, "robustness_score")
    min_r = float(getattr(settings, "paper_min_robustness", 6.0))
    add("robustness", rob >= min_r, f"robustness_score={rob:.2f} >= {min_r}")

    conc = _g(row, "top5")
    max_c = float(getattr(settings, "paper_max_top5_concentration", 0.5))
    add("concentration", conc <= max_c, f"top5={conc:.3f} <= {max_c}")

    days = float(data_days) if data_days is not None else _g(row, "days")
    min_d = float(getattr(settings, "paper_min_days", 10))
    add("sample_days", days >= min_d, f"days={days:.0f} >= {min_d:.0f}")

    add("exit_not_cap_dominated", not bool(row.get("exit_cap_dominated", False)) if hasattr(row, "get") else True,
        f"exit_cap_dominated={row.get('exit_cap_dominated') if hasattr(row,'get') else 'NA'}")

    add("positive_exit_independence", _g(row, "exit_independence_ok", 1.0) >= 1.0
        if "exit_independence_ok" in (row.keys() if hasattr(row, "keys") else []) else True,
        "independent exit variants profitable", level=SOFT)

    if execution_model is not None and execution_model != "EXECUTABLE_MODEL":
        add("execution_model", True,
            f"{execution_model}: no bid/ask; cost model substitutes slippage",
            level=SOFT)

    reasons = [f"{c['check']}: {c['detail']}" for c in checks
               if not c["passed"] and c["level"] == HARD]
    warnings = [f"{c['check']}: {c['detail']}" for c in checks
                if not c["passed"] and c["level"] == SOFT]
    return {"eligible": len(reasons) == 0, "reasons": reasons, "warnings": warnings,
            "checks": checks}


def gate_rows(cands, settings, cost_model=None, data_days=None,
              execution_model=None, lookahead_ok=True):
    """Apply evaluate() to every candidate row; returns (rows, summary)."""
    out = []
    for _, r in cands.iterrows():
        mi = str(r.get("METRIC_INTEGRITY", "PASS"))
        g = evaluate(r, settings, cost_model=cost_model, data_days=data_days,
                     execution_model=execution_model, lookahead_ok=lookahead_ok,
                     metric_integrity=mi)
        rec = {"candidate": r.get("candidate"), "eligible": g["eligible"],
               "reasons": "; ".join(g["reasons"]) or "none",
               "warnings": "; ".join(g["warnings"]) or "none",
               "checks": json.dumps(g["checks"])}
        out.append(rec)
    import pandas as pd
    df = pd.DataFrame(out)
    summary = {"n": int(len(df)), "eligible": int(df["eligible"].sum()) if len(df) else 0}
    return df, summary


def strategy_spec(row, settings, cost_model=None, meta=None, run_id="", dataset_hash="",
                  config_hash=""):
    """Machine-readable deployable contract for a promoted candidate."""
    cm = cost_model.to_dict() if cost_model is not None else None
    exp = _g(row, "IS_expectancy")
    oos = _g(row, "FWD_OOS_expectancy")
    lot = int(getattr(settings, "lot_size", 0) or 0)
    premium_hint = None
    try:
        premium_hint = float(row.get("avg_entry_premium"))
    except (TypeError, ValueError, AttributeError):
        premium_hint = None
    capital = float(getattr(settings, "capital", 0.0) or 0.0)
    max_lots = None
    if premium_hint and lot and capital > 0:
        max_lots = int(capital // (premium_hint * lot))
    spec = {
        "strategy_id": f"{row.get('candidate')}@{config_hash}",
        "created_utc": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "status": "PAPER_CANDIDATE",
        "instrument": {
            "asset_class": "INDEX_OPTION",
            "underlying": (meta or {}).get("underlying", ["UNKNOWN"]),
            "expiries": (meta or {}).get("expiries", []),
            "option_types": sorted({str(row.get("option_type", ""))}) if row.get("option_type") else [],
            "strike_rule": ("select the discovered contracts named in the candidate; "
                            "re-select by moneyness from the underlying reference at "
                            "deployment time"),
            "lot_size": lot,
        },
        "signal": {
            "candidate": row.get("candidate"),
            "family": row.get("discovery_family"),
            "feature": row.get("feature_definition"),
            "formula": row.get("formula"),
            "timeframe": row.get("timeframe"),
            "evaluated_at": "bar close t (all inputs strictly <= t)",
            "direction": row.get("direction", "long"),
            "entry_fill": getattr(settings, "entry_fill", "next_open"),
        },
        "exits": {
            "stop_loss_pct": getattr(settings, "exit_sl_pct", None),
            "take_profit_pct": getattr(settings, "exit_tp_pct", None),
            "max_hold_bars": getattr(settings, "exit_hold_bars", None),
            "eod_square_off": getattr(settings, "eod_square_off", True),
            "gap_fill": "open when the bar opens beyond the level",
        },
        "risk": {
            "capital": capital,
            "lot_size": lot,
            "max_lots": max_lots,
            "max_concurrent_positions": 1,
            "max_daily_loss_pct": 2.0,
            "note": "max_lots is a capital cap only; size to the loss budget before going live",
        },
        "costs": cm,
        "evidence": {
            "events": row.get("events"), "clusters": row.get("clusters"),
            "IS_expectancy_net": exp, "IS_trade_sharpe": _g(row, "IS_TRADE_SHARPE"),
            "OOS_events": row.get("OOS_events"), "OOS_expectancy": oos,
            "perm_p_adj": _g(row, "perm_p_adj"),
            "robustness_score": _g(row, "robustness_score"),
            "top5_concentration": _g(row, "top5"),
            "avg_cost_pct_of_premium": _g(row, "cost_pct_of_premium"),
            "TRADE_LEDGER_HASH": row.get("TRADE_LEDGER_HASH"),
        },
        "provenance": {
            "run_id": run_id, "dataset_hash": dataset_hash,
            "configuration_hash": config_hash,
            "engine_version": getattr(settings, "engine_version", ""),
            "feature_version": getattr(settings, "feature_version", ""),
            "random_seed": getattr(settings, "random_seed", None),
            "settings": settings.to_dict(),
        },
    }
    return spec
