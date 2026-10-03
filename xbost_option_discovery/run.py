"""Option-native discovery orchestrator — iterative frontier search engine.

Pipeline (frozen order, §3):
  RAW DATA → NORMALIZATION → FEATURE ENGINE → DISCOVERY → TRADING-RULE
  GENERATION → TRAIN → VALIDATION → ROBUSTNESS → FROZEN OOS →
  MULTIPLE TESTING → PAPER GATE

OOS is frozen: fixed before evaluation, never used for optimization. Any
candidate modified after OOS exposure receives a NEW hypothesis ID.

Search: iterative queue-based frontier (§4/§25), diversity quotas (§7),
missingness tiers (§8), return-path + staged exit discovery (§9-§12),
generalization battery (§15-§20), hard robustness caps (§40), global
multiple testing (§28), execution-model separation (§31/§32), checkpoint
resume (§53). No unbounded recursion anywhere.
"""
import argparse
import hashlib
import itertools
import os
import time
import traceback
import uuid

import pandas as pd
import numpy as np

from .ingestion import (load_dataset, detect_chain, select_focus,
                        module_availability, data_health, build_registry)
from .chain_normalizer import normalize
from .settings import DiscoverySettings
from .timeframe import detect_frequency, resample_ohlcv
from .divergence import (add_divergence_events, add_convergence_events,
                         add_catchup_events, catchup_outcomes, FORMULAS)
from .features import add_raw, add_volume, add_baselines, FEATURE_COUNT
from .relationships import (add_type_relationship, add_crossstrike, add_breadth,
                            REL_COUNT, REGISTRY)
from .sequences import (add_atomic_events, add_combo_events, add_sequences,
                        add_states, SEQ_COUNT, STATE_COUNT)
from .labels import add_labels, FW
from .validation import chronological_splits, walk_forward, cluster, oos_gate
from .metrics import (calculate_trade_metrics, metric_recalculation_test,
                      daily_sharpe, bootstrap_sharpe, surrogate_stats, SHARPE_DEFS,
                      label_metrics, cap_dominance, block_bootstrap_ci, proportion_ci)
from .robustness import (concentration, best_removal, time_split, entry_perturbation,
                         exit_independence, parameter_neighborhood, robustness_score)
from .multiple_testing import bh, holm, bonferroni
from .backtest import backtest, propagation_gate
from .leakage import test_no_lookahead
from .reporting import write_report, assign_status
from .filters import run_filters
from .feature_quality import audit_features, tier_of, allowed_use
from .search import (HypothesisRegistry, FrontierQueue, ConvergenceChecker,
                     SearchController, Watchdog, canonical_hash,
                     build_next_cycle_plan, save_checkpoint, load_checkpoint,
                     CYCLE_STATUSES, EXPLORATION_FAMILIES)
from .return_path import compute_return_path, first_touch_stats, classify_path
from .exits import discover_exits
from .generalization import (contract_generalization, strike_robustness,
                             expiry_robustness, otype_robustness,
                             time_robustness, regime_robustness)
from .edge_ladder import (edge_ladder, final_status, paper_eligible,
                           discovery_category, edge_levels_l1_l8, oos_stage,
                           oos_final_survivor)

LAG_WINDOWS = (1, 2, 3, 5, 10)
MIN_EVENTS = 50

# locked final exit configs by hypothesis (for post-search audits)
_EXIT_CFG = {}

# ledger identity failure counters (§39 TEST 6-9, §48)
_LEDGER_AUDIT = {"trade_cross_instrument": 0, "trade_cross_symbol": 0,
                 "trade_cross_expiry": 0, "ledger_identity_fail": 0,
                 "trades_checked": 0}


def ledger_identity_counts(led_all, led_oos, feat):
    """TEST 6/7/8/9 per evaluation: exit instrument/symbol/expiry must match
    entry; every trade carries complete identity; exits strictly after entry."""
    fails = {"trade_cross_instrument": 0, "trade_cross_symbol": 0,
             "trade_cross_expiry": 0, "ledger_identity_fail": 0,
             "trades_checked": 0}
    try:
        import pandas as _pd
        for _led in (led_all, led_oos):
            if _led is None or len(_led) == 0:
                continue
            fails["trades_checked"] += int(len(_led))
            for _c in ("symbol_id", "instrument_id", "expiry",
                       "contract_id"):
                if _c not in _led.columns or _led[_c].isna().any():
                    fails["ledger_identity_fail"] += 1
            try:
                _bad_time = (pd.to_datetime(_led["exit_time"])
                             <= pd.to_datetime(_led["entry_time"])).sum()
                fails["ledger_identity_fail"] += int(_bad_time)
            except Exception:
                pass
            try:
                _featsyms = set(feat["symbol"].astype(str).tolist())
                _outsiders = (~_led["contract_id"].astype(str).isin(
                    _featsyms)).sum()
                fails["trade_cross_instrument"] += int(_outsiders)
            except Exception:
                pass
    except Exception:
        pass
    for _k, _v in fails.items():
        _LEDGER_AUDIT[_k] = _LEDGER_AUDIT.get(_k, 0) + _v
    return fails

# map internal discovery families onto §7 exploration buckets
FAMILY_BUCKET = {
    "RAW_OPTION_PRICE": "VOLATILITY", "OPTION_VOLUME": "VOLUME",
    "EVENT": "VOLATILITY", "DIVERGENCE": "DIVERGENCE",
    "CONVERGENCE": "CONVERGENCE", "CATCHUP": "CATCHUP",
    "CROSS_STRIKE_RELATIONSHIP": "STRIKE_RELATIONSHIP",
    "STRIKE_RELATIONSHIP": "STRIKE_RELATIONSHIP",
    "OPTION_TYPE_RELATIONSHIP": "OPTION_TYPE_RELATIONSHIP",
    "CHAIN_BREADTH": "CHAIN_STATE", "SEQUENCE": "SEQUENCE",
    "CHAIN_STATE": "CHAIN_STATE", "LEAD_LAG": "LEAD_LAG",
    "COMBINATION": "RETURN_PATH", "EXIT_STRUCTURE": "EXIT_STRUCTURE",
    "ENTRY_TIMING": "RETURN_PATH",
}


def _bucket(fam):
    return FAMILY_BUCKET.get(fam, "MOMENTUM")


def _shift_mask(feat, mask, k):
    """Entry timing shift t+k within contract (§14), iterative (no recursion)."""
    f2 = feat[["symbol", "timestamp"]].copy()
    f2["_m"] = mask.values
    f2 = f2.sort_values(["symbol", "timestamp"])
    f2["_m"] = f2.groupby("symbol")["_m"].shift(k).fillna(False).astype(bool)
    out = pd.Series(False, index=feat.index)
    out.loc[f2.index] = f2["_m"].values
    return out


def evaluate_candidate(feat, mask, cid, fam, feature_def, label, rel,
                       direction, tf, splits, settings, min_events,
                       hyp, depth, exit_cfg, has_bidask, do_exit_search,
                       do_entry_search, registry):
    """Full L1-L8 evaluation of ONE entry hypothesis with first-class exit
    discovery. OOS evaluated once on the locked final rule, frozen."""
    from .metrics import label_metrics as _lm
    mask = mask.fillna(False)
    item_recipe = hyp.get("recipe") if isinstance(hyp, dict) else None
    if mask.sum() < min_events:
        return None
    tr = splits["discovery"] + splits["refinement"]
    oos_days = splits["pseudo_oos"]
    BASELINE = {"hold": int(settings.exit_hold_bars),
                "sl": float(settings.exit_sl_pct),
                "tp": float(settings.exit_tp_pct),
                "trail_cfg": {"kind": "none"},
                "stop_type": "FIXED_PERCENT",
                "target_type": "FIXED_PERCENT", "trail_type": "NONE"}
    # ---- contract universe budget (§9): log available/considered/excluded ----
    _avail_contracts = sorted(feat.loc[mask, "symbol"].dropna().unique().tolist()) \
        if "symbol" in feat.columns else []
    _maxc = int(getattr(settings, "max_contracts_per_hypothesis", 0) or 0)
    _excluded_contracts, _excl_reason = [], ""
    if _maxc > 0 and len(_avail_contracts) > _maxc:
        try:
            _vol = feat.loc[mask].groupby("symbol")["volume"].sum().sort_values(
                ascending=False)
            _keep = set(_vol.head(_maxc).index.tolist())
            _excluded_contracts = [c for c in _avail_contracts if c not in _keep]
            _excl_reason = (f"contract budget max_contracts_per_hypothesis={_maxc}")
            mask = mask & feat["symbol"].isin(_keep)
        except Exception:
            pass
    # ---- OOS information level (rule-independent, frozen partitions) ----
    fwd_tr = _lm(feat.loc[mask & feat["day"].isin(tr), "fwd_ret_5m"]) if tr else _lm([])
    fwd_oos = _lm(feat.loc[mask & feat["day"].isin(oos_days), "fwd_ret_5m"]) \
        if oos_days else _lm([])
    fwd_all = _lm(feat.loc[mask, "fwd_ret_5m"])
    oos_info = ("OOS_SURVIVED_MARK"
                if (pd.notna(fwd_oos["expectancy"]) and fwd_oos["expectancy"] > 0)
                else "OOS_REJECTED")
    # ---- return path (§6/§8): independent of exits ----
    rpath = compute_return_path(feat, mask)
    touch = first_touch_stats(feat, mask, sl_pct=float(settings.exit_sl_pct),
                              tp_pct=float(settings.exit_tp_pct),
                              hold=int(settings.exit_hold_bars))
    rpath.update(touch)
    rpath["path_class"] = classify_path(rpath)
    # ---- BASELINE ledger (§27/§28): configured benchmark ONLY ----
    led_base = backtest(feat, mask, hold_bars=int(settings.exit_hold_bars),
                        sl=float(settings.exit_sl_pct),
                        tp=float(settings.exit_tp_pct),
                        exit_mode="premium", cid=f"{cid}:BASELINE",
                        stop_type="FIXED_PERCENT",
                        target_type="FIXED_PERCENT", trail_type="NONE",
                        dataset_split="train_validation")
    m_base = calculate_trade_metrics(led_base)
    registry.count_test(1)
    promising = bool(pd.notna(fwd_tr["expectancy"])
                     and fwd_tr["expectancy"] > 0
                     and mask.sum() >= min_events)
    # ---- OPTION_EXIT_DISCOVERY on VALIDATION only (never OOS) ----
    exit_search = {"best": dict(BASELINE), "improved": False, "stages": [],
                   "matrix": [], "excluded_invalid": [],
                   "exit_status": "BASELINE_ONLY (exit search skipped: "
                   "entry not promising on validation)"}
    if do_exit_search and promising:
        try:
            exit_search = discover_exits(
                feat, mask, splits["refinement"] or tr, settings, rpath,
                registry)
        except Exception:
            exit_search["exit_status"] = "FAILED (exception; baseline kept)"
    fin = dict(BASELINE)
    if isinstance(exit_cfg, dict) and exit_cfg.get("stop_type"):
        # PRESCRIBED exit variant from the frontier (§7): evaluate the
        # specified structure directly instead of re-running discovery
        fin = {"hold": int(exit_cfg.get("hold", 5)),
               "sl": float(exit_cfg.get("sl", 0.5)),
               "tp": float(exit_cfg.get("tp", 1.0)),
               "trail_cfg": exit_cfg.get("trail_cfg") or {"kind": "none"},
               "stop_type": exit_cfg.get("stop_type", "FIXED_PERCENT"),
               "target_type": exit_cfg.get("target_type", "FIXED_PERCENT"),
               "trail_type": exit_cfg.get("trail_type", "NONE")}
        exit_search["exit_status"] = "PRESCRIBED_VARIANT"
        exit_search["best"] = dict(fin)
        registry.count_test(1)
    else:
        fin = exit_search.get("best", dict(BASELINE))
    hold = int(fin.get("hold", 5))
    sl = float(fin.get("sl", 0.5))
    tp = float(fin.get("tp", 1.0))
    trail_cfg = fin.get("trail_cfg") or {"kind": "none"}
    stop_type = fin.get("stop_type", "FIXED_PERCENT")
    target_type = fin.get("target_type", "FIXED_PERCENT")
    trail_type = fin.get("trail_type", "NONE")
    _tc = None if trail_cfg.get("kind") == "none" else trail_cfg
    exit_status = exit_search.get("exit_status", "BASELINE_ONLY")
    try:
        _EXIT_CFG[hyp.get("hypothesis_id", cid)] = {
            "hold": hold, "sl": sl, "tp": tp, "trail_cfg": trail_cfg,
            "stop_type": stop_type, "target_type": target_type,
            "trail_type": trail_type}
    except Exception:
        pass
    # unresolved routing (§7): predictive entry, no working exit → frontier
    if promising and exit_status in ("BASELINE_KEPT", "FAILED (exception; baseline kept)"):
        exit_status = "EXIT_DISCOVERY_RAN_NO_IMPROVEMENT"
    # ---- FINAL trading ledger on train+val (locked discovered rule) ----
    led_all = backtest(feat, mask, hold_bars=hold, sl=sl, tp=tp,
                       trail=None, trail_cfg=_tc, exit_mode="premium", cid=cid,
                       stop_type=stop_type, target_type=target_type,
                       trail_type=trail_type, dataset_split="train_validation")
    if len(led_all) < min_events:
        return None
    m_all = calculate_trade_metrics(led_all)
    integ = metric_recalculation_test(
        {"trade_count": m_all["trade_count"], "wins": m_all["wins"],
         "losses": m_all["losses"], "avg_winner": m_all["avg_winner"],
         "avg_loser": m_all["avg_loser"], "expectancy": m_all["expectancy"],
         "PF": m_all["PF"], "TRADE_SHARPE": m_all["TRADE_SHARPE"],
         "P&L": m_all["P&L"]}, led_all)
    # ---- frozen OOS on the FINAL rule only, evaluated once ----
    oos_mask = mask & feat["day"].isin(oos_days) if oos_days else \
        pd.Series(False, index=feat.index)
    led_oos = backtest(feat, oos_mask, hold_bars=hold, sl=sl, tp=tp,
                       trail=None, trail_cfg=_tc, exit_mode="premium", cid=cid,
                       stop_type=stop_type, target_type=target_type,
                       trail_type=trail_type, oos_flag=True,
                       dataset_split="oos")
    m_oos = calculate_trade_metrics(led_oos)
    oos_trading_exp = m_oos["expectancy"]
    oos_trading_pass = bool(pd.notna(oos_trading_exp) and oos_trading_exp > 0
                            and len(led_oos) >= settings.min_oos_events)
    _lid = ledger_identity_counts(led_all, led_oos, feat)
    # ---- entry timing/perturbation on train/val (§10/§13/§14) ----
    # same-bar, +1/+2/+3 min, 1-bar confirmation. New research questions only;
    # each variant increments GLOBAL_TEST_COUNT. No OOS reuse.
    entry_variants, entry_best = {}, "signal-close"
    if do_entry_search:
        base_e = fwd_tr["expectancy"]
        try:
            _prev = _shift_mask(feat, mask, 1)  # previous-bar signal at bar t
            _confirm = mask.fillna(False) & _prev
        except Exception:
            _confirm = pd.Series(False, index=feat.index)
        for name, m2 in (("signal-close", mask),
                         ("t+1", _shift_mask(feat, mask, 1)),
                         ("t+2", _shift_mask(feat, mask, 2)),
                         ("t+3", _shift_mask(feat, mask, 3)),
                         ("confirm-1bar", _confirm)):
            v = pd.to_numeric(feat.loc[m2.fillna(False) & feat["day"].isin(tr),
                                       "fwd_ret_5m"], errors="coerce").dropna()
            e = float(v.mean()) if len(v) >= min_events else float("nan")
            entry_variants[name] = {"expectancy": e, "n": int(len(v))}
            registry.count_test(1)
        cands = [(k, v["expectancy"]) for k, v in entry_variants.items()
                 if pd.notna(v["expectancy"])]
        if cands and pd.notna(base_e):
            entry_best = max(cands, key=lambda kv: kv[1])[0]
    # ---- generalization battery (§15-§20) ----
    cg = contract_generalization(feat, mask)
    sr = strike_robustness(feat, mask)
    er = expiry_robustness(feat, mask)
    or_ = otype_robustness(feat, mask)
    tir = time_robustness(feat, mask)
    rr = regime_robustness(feat, mask)
    # ---- concentration / best-removal / bootstrap / surrogate ----
    cap = cap_dominance(led_all)
    conc = concentration(led_all["ret"])
    br = best_removal(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
    # §21 extensions: hold perturbation, best-day removal, trade-order
    # randomization (UNTESTABLE stays UNTESTABLE, never a fake score)
    hold_perturb, bestday, shufl = "UNTESTABLE", "UNTESTABLE", "UNTESTABLE"
    try:
        from .backtest import backtest as _bt
        _hp = []
        for _h in (max(1, hold - 1), hold + 1):
            try:
                _l = _bt(feat, mask.fillna(False) & feat["day"].isin(tr),
                         hold_bars=int(_h), sl=float(sl), tp=float(tp),
                         trail=None,
                         trail_cfg=None if trail_cfg.get("kind") == "none" else trail_cfg,
                         exit_mode="premium", cid="HOLDPERT", verify=False,
                         stop_type=stop_type, target_type=target_type,
                         trail_type=trail_type)
                _hp.append(float(_l["ret"].mean()) if len(_l) else float("nan"))
                registry.count_test(1)
            except Exception:
                _hp.append(float("nan"))
        hold_perturb = {"hold_minus1": _hp[0], "hold_plus1": _hp[1],
                        "stable": bool(all(pd.notna(_hp))) and
                        (all(x > 0 for x in _hp) ==
                         (pd.notna(m_all["expectancy"]) and m_all["expectancy"] > 0))}
    except Exception:
        pass
    try:
        _by = pd.to_numeric(led_all["ret"], errors="coerce").groupby(
            pd.to_datetime(led_all["entry_time"]).dt.date).sum()
        if len(_by) > 1:
            bestday = float(_by.drop(_by.idxmax()).mean())
    except Exception:
        pass
    try:
        _r = pd.to_numeric(led_all["ret"], errors="coerce").dropna().values
        if len(_r) >= 10:
            _rng = np.random.default_rng(42)
            _dds = []
            for _ in range(50):
                _eq = pd.Series(_rng.permutation(_r)).cumsum()
                _dds.append(float((_eq - _eq.cummax()).min()))
            shufl = {"shuffled_maxDD_mean": round(float(np.mean(_dds)), 4),
                     "observed_maxDD": m_all["maxDD"]}
    except Exception:
        pass
    try:
        ei = exit_independence(feat, mask, cid, int(hold))
    except Exception:
        ei = {"n_variants": 0, "profitable_variants": 0,
              "median_performance": float("nan")}
    cl = cluster(feat.loc[mask, ["timestamp", "symbol"]].assign(
        expiry=feat.loc[mask, "expiry"], strike=feat.loc[mask, "strike"],
        option_type=feat.loc[mask, "option_type"],
        symbol_id=feat.loc[mask, "symbol_id"] if "symbol_id" in feat.columns else "",
        instrument_id=feat.loc[mask, "instrument_id"] if "instrument_id" in feat.columns else feat.loc[mask, "symbol"]))
    n_clu = int(cl["cluster_id"].nunique())
    ds = daily_sharpe(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
    bs = bootstrap_sharpe(led_all["ret"])
    sg = surrogate_stats(led_all["ret"], n_perm=int(settings.n_perm))
    bb = block_bootstrap_ci(led_all["ret"])
    wr_ci = proportion_ci(m_all["wins"], m_all["trade_count"])
    padj = float(fwd_all["surrogate_p"]) if pd.notna(fwd_all["surrogate_p"]) else 1.0
    og = oos_gate(len(led_oos), settings.min_oos_events) if oos_days else "THIN_OOS"
    status = assign_status(len(led_all), n_clu, int(feat.loc[mask, "day"].nunique()),
                           len(led_oos),
                           float(fwd_oos["expectancy"]) if pd.notna(fwd_oos["expectancy"]) else float("nan"),
                           float(fwd_tr["expectancy"]) if pd.notna(fwd_tr["expectancy"]) else float("nan"),
                           padj, conc["top5"], og, cap_dominated=cap["cap_dominated"])
    if integ["METRIC_INTEGRITY"] == "FAIL":
        status = "REJECTED"
    # ---- robustness score with coverage + hard caps (§38/§39/§40) ----
    def _pos(x):
        try:
            return 1.0 if float(x) > 0 else 0.0
        except (TypeError, ValueError):
            return None
    neigh = None
    try:
        thr = [mask.mean()]
        neigh = parameter_neighborhood(
            lambda p: float(pd.to_numeric(
                feat.loc[mask, "fwd_ret_5m"], errors="coerce").dropna().mean()),
            [{"thr": t} for t in thr])
    except Exception:
        neigh = None
    comp = {
        "signal": 1.0 if (pd.notna(fwd_all["expectancy"]) and fwd_all["expectancy"] > 0) else 0.0,
        "sample": min(1.0, n_clu / 50),
        "param": None if neigh is None else float(neigh.get("positive_expectancy_density", 0) or 0),
        "time": 1.0 if tir["status"] == "PASS" else (0.0 if tir["status"] == "FAIL" else None),
        "contract": 1.0 if cg["status"] == "PASS" else (0.0 if cg["status"] == "FAIL" else None),
        "oos": 1.0 if oos_trading_pass else 0.0,
        "exit": (ei["profitable_variants"] / max(1, ei["n_variants"])) if ei["n_variants"] else None,
        "concentration": max(0.0, 1.0 - conc["top5"]),
        "best_event": 1.0 if pd.notna(br.get("rm_best3")) and br["rm_best3"] > 0 else 0.0,
        "stats": 1.0 if padj < 0.10 else 0.0,
    }
    rs = robustness_score(comp)
    # trade dependence (§37): autocorrelation + clustering
    try:
        r = pd.to_numeric(led_all["ret"], errors="coerce").dropna()
        ac1 = float(r.autocorr(1)) if len(r) > 10 else float("nan")
        eff_n = int(n_clu)
    except Exception:
        ac1, eff_n = float("nan"), n_clu
    eq = pd.to_numeric(led_all["ret"], errors="coerce").fillna(0).cumsum()
    step = max(1, len(eq) // 100)
    equity_curve = [round(float(x), 4) for x in eq.iloc[::step].tolist()]
    dd = (eq - eq.cummax()).tolist()
    drawdown_curve = [round(float(x), 4) for x in dd[::step]]
    fail = []
    if og == "THIN_OOS":
        fail.append("THIN_OOS")
    if conc["top5"] > 0.5:
        fail.append("concentration")
    if padj >= 0.1:
        fail.append("surrogate-fail")
    if integ["METRIC_INTEGRITY"] == "FAIL":
        fail.append("metric-fail")
    if cap["cap_dominated"]:
        fail.append("exit-cap-dominated")
    if oos_info == "OOS_REJECTED":
        fail.append("OOS_INFO_REJECTED")
    if not oos_trading_pass:
        fail.append("OOS_TRADING_REJECTED")
    row = {
        "candidate": cid, "hypothesis_id": hyp["hypothesis_id"],
        "combination_depth": depth, "parent_ids": ";".join(hyp.get("parent_ids", [])),
        "discovery_family": fam, "family_bucket": _bucket(fam),
        "feature_definition": feature_def,
        "formula": f"EVENT=({feature_def}) at bar t; LABEL={label}",
        "timestamp_definition": "signal bar close t (past-only)",
        "forward_label_definition": label, "type": "OPTION_NATIVE_DISCOVERY",
        "contract": rel, "direction": direction, "timeframe": tf,
        "symbol_id": str(feat["symbol_id"].iloc[0])
        if "symbol_id" in feat.columns and len(feat) else "UNKNOWN",
        "entry_rule": hyp.get("entry_rule", "signal-close"),
        "entry_best_variant": entry_best, "entry_variants": str(entry_variants),
        "entry_timing": entry_best, "entry_price_rule": "signal bar close t",
        "strategy_scope": "SINGLE_CONTRACT",
        "mask_recipe": __import__("json").dumps(
            item_recipe or {}, default=str),
        "exit_rule": f"hold={hold}/sl={sl}/tp={tp}/trail={trail_cfg} "
                     f"stop_type={stop_type} target_type={target_type} "
                     f"trail_type={trail_type}",
        "exit_hold": hold, "exit_sl": sl, "exit_tp": tp,
        "exit_trail_cfg": str(trail_cfg),
        "exit_stop_type": stop_type, "exit_target_type": target_type,
        "exit_trail_type": trail_type,
        "exit_discovery_status": exit_status,
        "exit_search_best": __import__("json").dumps(
            exit_search.get("best", {}), default=str),
        "exit_search_improved": bool(exit_search.get("improved")),
        "exit_combos_evaluated": int(exit_search.get("n_combos_evaluated", 0)),
        "exit_combos_excluded": len(exit_search.get("excluded_invalid", [])),
        "BASELINE_exit": (f"SL={settings.exit_sl_pct}/TP={settings.exit_tp_pct}/"
                          f"hold={settings.exit_hold_bars} (benchmark only)"),
        "BASELINE_expectancy": m_base["expectancy"],
        "BASELINE_trades": m_base["trade_count"],
        "DISCOVERED_expectancy": m_all["expectancy"],
        "contracts_available": len(_avail_contracts),
        "contracts_considered": len(_avail_contracts) - len(_excluded_contracts),
        "contracts_excluded": ";".join(_excluded_contracts[:12]),
        "contract_exclusion_reason": _excl_reason,
        "events": m_all["trade_count"], "clusters": n_clu,
        "effective_sample_size": eff_n, "trade_autocorr_lag1": ac1,
        "wins": m_all["wins"], "losses": m_all["losses"],
        "avg_winner": m_all["avg_winner"], "median_winner": m_all["median_winner"],
        "avg_loser": m_all["avg_loser"], "median_loser": m_all["median_loser"],
        "payoff": m_all["payoff"], "maxDD": m_all["maxDD"],
        "largest_winner": m_all["largest_winner"], "largest_loser": m_all["largest_loser"],
        "FWD_events": fwd_all["n"], "FWD_WR": fwd_all["WR"],
        "FWD_expectancy": fwd_all["expectancy"], "FWD_median": fwd_all["median"],
        "FWD_TRADE_SHARPE": fwd_all["TRADE_SHARPE"], "FWD_PF": fwd_all["PF"],
        "FWD_IS_expectancy": fwd_tr["expectancy"],
        "FWD_OOS_events": fwd_oos["n"], "FWD_OOS_expectancy": fwd_oos["expectancy"],
        "FWD_OOS_WR": fwd_oos["WR"],
        "OOS_information_result": oos_info,
        "OOS_events": len(led_oos), "OOS_expectancy": m_oos["expectancy"],
        "OOS_WR": float((led_oos["ret"] > 0).mean()) if len(led_oos) else 0.0,
        "OOS_result": ("OOS_SURVIVED_MARK" if oos_trading_pass else "OOS_REJECTED"),
        "OOS_trading_result": ("OOS_TRADING_RULE_PASS" if oos_trading_pass
                               else "OOS_TRADING_RULE_FAIL"),
        "IS_expectancy": m_all["expectancy"], "IS_PF": m_all["PF"],
        "IS_TRADE_SHARPE": m_all["TRADE_SHARPE"], "IS_Sortino": m_all["Sortino"],
        "IS_MAE": m_all["MAE"], "IS_MFE": m_all["MFE"],
        "IS_DAILY_SHARPE": ds["DAILY_SHARPE"],
        "IS_BOOTSTRAP_SHARPE": bs["BOOTSTRAP_SHARPE"],
        "IS_BLOCK_BOOTSTRAP_CI": str(bb["block_bootstrap_ci"]),
        "WR_CI": str(wr_ci), "IS_SURROGATE_SHARPE": sg["SURROGATE_SHARPE"],
        "exit_cap_dominated": cap["cap_dominated"],
        "exit_reason_mix": str(cap["exit_reason_mix"]),
        "return_path": str({k: rpath["horizons"].get(k) for k in (1, 3, 5, 10, 15, 30)}),
        "return_path_class": rpath["path_class"],
        "MFE_median": rpath["MFE"].get("median"), "MAE_median": rpath["MAE"].get("median"),
        "target_first_pct": rpath.get("target_first_pct"),
        "stop_first_pct": rpath.get("stop_first_pct"),
        "contract_status": cg["status"], "contract_positive_fraction": cg.get("positive_fraction", "NA"),
        "contract_count": cg.get("contract_count", 0),
        "strike_status": sr["status"], "expiry_status": er["status"],
        "otype_status": or_["status"], "time_status": tir["status"],
        "regime_status": rr["status"],
        "METRIC_INTEGRITY": integ["METRIC_INTEGRITY"],
        "TRADE_LEDGER_HASH": led_all.attrs.get("TRADE_LEDGER_HASH", ""),
        "equity_curve": equity_curve, "drawdown_curve": drawdown_curve,
        "top1": concentration(led_all["ret"]).get("top1"), "top5": conc["top5"],
        "top10": conc.get("top10"), "rm_best3": br.get("rm_best3"),
        "rm_best1": br.get("rm_best1"), "rm_best5": br.get("rm_best5"),
        "hold_perturbation": str(hold_perturb),
        "rm_bestday": bestday,
        "trade_order_randomization": str(shufl),
        "perm_p": padj, "final_status": status,
        "execution_model": ("EXECUTABLE_PRICE_MODEL" if has_bidask
                            else "RESEARCH_PRICE_MODEL"),
        "failure_reason": ";".join(fail) if fail else "none",
        "exit_independence": str({k: ei[k] for k in
                                  ("n_variants", "profitable_variants",
                                   "median_performance") if k in ei}),
        "robustness_score": rs["robustness_score"],
        "robustness_coverage": rs.get("robustness_coverage"),
        "robustness_untestable": ",".join(rs.get("untestable_tests", [])),
        "robustness_caps": ";".join(rs.get("caps_applied", [])),
        "robustness_components": str(rs["components"]),
    }
    lad = edge_ladder(row)
    row["edge_kind"] = lad["edge_kind"]
    row["edge_fails_at"] = lad["fails_at"]
    # surrogate transparency (FIX 3): full null summary + empirical percentile
    row["surrogate_observed"] = sg.get("SURROGATE_SHARPE")
    row["surrogate_mean"] = sg.get("surrogate_mean")
    row["surrogate_sd"] = sg.get("surrogate_sd")
    row["surrogate_percentile"] = sg.get("observed_percentile")
    row["surrogate_n_perm"] = int(settings.n_perm)
    # failure-driven WHY (§22) + unresolved routing (§6)
    info_pos = pd.notna(fwd_all["expectancy"]) and fwd_all["expectancy"] > 0
    trad_pos = pd.notna(m_all["expectancy"]) and m_all["expectancy"] > 0
    val_pos = pd.notna(fwd_tr["expectancy"]) and fwd_tr["expectancy"] > 0
    if info_pos and not trad_pos:
        why, code, nxt = ("INFO_POS_TRADING_NEG",
                          "ENTRY_PROMISING_EXIT_UNRESOLVED",
                          "exit-discovery: alt holds, entry delay, MFE/MAE exits")
    elif val_pos and not trad_pos:
        why, code, nxt = ("VAL_POS_TRADING_NEG",
                          "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED",
                          "exit-discovery: MFE/MAE/time exits")
    elif (pd.notna(fwd_tr["expectancy"]) and fwd_tr["expectancy"] > 0) is False \
            and info_pos:
        why, code, nxt = ("TRAIN_POS_VAL_NEG", "",
                          "simplify: fewer conditions, orthogonal family")
    elif val_pos and not oos_trading_pass:
        why, code, nxt = ("VAL_POS_OOS_NEG", "",
                          "independent structural hypothesis; DO NOT tune OOS")
    elif oos_trading_pass and padj >= 0.10:
        why, code, nxt = ("OOS_POS_MT_RISK",
                          "OOS_PROMISING_BUT_MULTIPLE_TESTING_FAILED",
                          "simpler independent hypothesis, orthogonal family")
    elif trad_pos and rs["robustness_score"] < 4.0:
        why, code, nxt = ("TRADING_POS_ROBUST_WEAK", "",
                          "robustness-first: perturb, generalize, concentrate")
    elif not has_bidask and trad_pos:
        why, code, nxt = ("SIGNAL_EXECUTION_BLOCKED",
                          "ROBUST_SIGNAL_BUT_EXECUTION_UNAVAILABLE",
                          "flag data acquisition; research-only status")
    else:
        why, code, nxt = ("NO_EDGE_SIGNAL", "", "explore new family")
    row["failure_why"] = why
    row["unresolved_code"] = code
    row["next_action"] = nxt
    row["OOS_FROZEN"] = True
    row["OOS_REOPTIMIZED"] = False
    row["ledger_identity"] = ("PASS" if sum(_lid.get(k, 0) for k in
                              ("trade_cross_instrument", "trade_cross_symbol",
                               "trade_cross_expiry",
                               "ledger_identity_fail")) == 0 else "FAIL")
    # research-registry status (§33)
    if code == "ENTRY_PROMISING_EXIT_UNRESOLVED":
        reg_status = "ENTRY_PROMISING_EXIT_UNRESOLVED"
    elif exit_search.get("improved"):
        reg_status = "EXIT_PROMISING"
    elif conc["top5"] > 0.5:
        reg_status = "CONCENTRATION_REJECTED"
    elif str(row.get("contract_status")) == "FAIL":
        reg_status = "CONTRACT_CONCENTRATION"
    elif padj >= 0.10:
        reg_status = "SURROGATE_REJECTED"
    elif oos_trading_pass:
        reg_status = "OOS_POSITIVE"
    elif pd.notna(fwd_tr["expectancy"]) and fwd_tr["expectancy"] > 0:
        reg_status = "VALIDATION_POSITIVE"
    elif pd.notna(fwd_all["expectancy"]) and fwd_all["expectancy"] > 0:
        reg_status = "TRAIN_POSITIVE"
    else:
        reg_status = "TESTED"
    row["registry_status"] = reg_status
    try:
        registry.hypotheses[hyp["hypothesis_id"]]["registry_status"] = reg_status
        registry.hypotheses[hyp["hypothesis_id"]]["train_result"] = fwd_all["expectancy"]
        registry.hypotheses[hyp["hypothesis_id"]]["validation_result"] = fwd_tr["expectancy"]
        registry.hypotheses[hyp["hypothesis_id"]]["oos_result"] = row["OOS_trading_result"]
        registry.hypotheses[hyp["hypothesis_id"]]["robustness_result"] = rs["robustness_score"]
        registry.hypotheses[hyp["hypothesis_id"]]["failure_class"] = why
    except Exception:
        pass
    return row


def _resolve_mask(feat, hid, hreg, atomic_masks, mask_cache, frontier):
    """Iterative mask resolution (no recursion): atomic → feature column;
    lead/lag → stored params; combo → AND of parent masks + confirm leg;
    exit-variant → parent mask."""
    if hid in mask_cache:
        return mask_cache[hid]
    if hid in atomic_masks:
        try:
            return atomic_masks[hid]["mask_fn"](feat).fillna(False)
        except Exception:
            return pd.Series(False, index=feat.index)
    rec = hreg.hypotheses.get(hid, {})
    if "_ll_mask" in rec:
        return rec["_ll_mask"]
    if "_ll_params" in rec:
        try:
            p = rec["_ll_params"]
            src_idx = feat[feat["symbol"] == p["source"]].set_index(
                "timestamp").sort_index().index
            tgt_rows = feat[(feat["symbol"] == p["target"]) &
                            feat["timestamp"].isin(
                                pd.DatetimeIndex(sorted(src_idx)) +
                                pd.Timedelta(minutes=int(p["lag"])))]
            sm = pd.Series(False, index=feat.index)
            sm.loc[tgt_rows.index] = True
            return sm
        except Exception:
            return pd.Series(False, index=feat.index)
    parents = rec.get("parent_ids", [])
    if not parents and hid in frontier.items:
        parents = frontier.items[hid].get("parent_hypotheses", [])
    m = pd.Series(True, index=feat.index)
    for p in parents:
        pm = _resolve_mask(feat, p, hreg, atomic_masks, mask_cache, frontier)
        m = m & pm.fillna(False)
    leg = frontier.items.get(hid, {}).get("confirm_feature") if hid in frontier.items else None
    if leg and leg in feat.columns:
        try:
            m = m & (feat[leg] == 1).fillna(False)
        except Exception:
            pass
    return m


def build_feature_frame(sub, meta, strikes, mods):
    """Full feature pipeline on one scope (focus chain or full universe).
    Registry/counters snapshot-restored so a second build for the full
    universe does not double-count the global research ledger."""
    from .relationships import REL_COUNT as _RC, REGISTRY as _RG
    from .features import FEATURE_COUNT as _FC
    from .sequences import SEQ_COUNT as _SC, STATE_COUNT as _STC
    _snap = {"x": list(_RG["x_cols"]), "t": list(_RG["type_cols"]),
             "b": list(_RG["breadth_cols"]), "rel": _RC["n"],
             "feat": _FC["n"], "seq": _SC["n"], "st": _STC["n"]}
    try:
        feat = add_raw(sub)
        feat = add_volume(feat)
        feat = add_baselines(feat)
        if mods["OPTION_TYPE_RELATIONSHIP"][0] == "AVAILABLE":
            feat = add_type_relationship(feat, meta)
        if mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE":
            feat = add_crossstrike(feat, meta, strikes)
        feat = add_breadth(feat, meta)
        dup = int(feat.duplicated(subset=["timestamp", "symbol"]).sum())
        if dup:
            raise SystemExit("FEATURE_ERROR duplicate rows")
        feat = add_divergence_events(feat)
        feat = add_convergence_events(feat, _RG["x_cols"])
        feat = add_catchup_events(feat, _RG["x_cols"])
        lead_cols = [c for c in feat.columns if "_leads_" in c]
        feat = add_atomic_events(feat)
        feat = add_combo_events(feat, lead_cols)
        feat = add_sequences(feat)
        feat = add_states(feat, meta)
        feat = add_labels(feat)
        return feat
    finally:
        _RG["x_cols"] = _snap["x"]
        _RG["type_cols"] = _snap["t"]
        _RG["breadth_cols"] = _snap["b"]
        _RC["n"] = _snap["rel"]
        _FC["n"] = _snap["feat"]
        _SC["n"] = _snap["seq"]
        _STC["n"] = _snap["st"]


def contract_levels_and_transfer(row, recipe, own_id, symbol_store,
                                 settings, registry, min_events):
    """§10/§11: independent CANDIDATE×CONTRACT evaluation first, aggregate
    second. Level A (single contract) → B (same expiry) → C (cross-expiry)
    → D (cross-symbol transfer, separate test). TEST 10 pool==sum check.
    Aggregation scope printed per statistic (§29)."""
    from .backtest import backtest as _bt
    from .metrics import calculate_trade_metrics as _ctm
    from .identity import audit_pool_sum
    out = {"level_A": [], "level_B": [], "level_C": {},
           "level_D": [], "test10": {"pool_sum_match": "UNTESTABLE"},
           "transfer_expectancy": float("nan"),
           "agg_audit": []}
    own = symbol_store.get(own_id, {})
    feat = own.get("feat")
    splits = own.get("splits", {})
    tr = (splits.get("discovery", []) or []) + (splits.get("refinement", []) or [])
    if feat is None or len(feat) == 0:
        return out
    base = own.get("masks", {}).get(row.get("hypothesis_id"))
    if base is None:
        return out
    try:
        import json as _j
        _rec = recipe
        if isinstance(_rec, str):
            _rec = _j.loads(_rec)
        _full = own.get("feat_full")
        if isinstance(_rec, dict) and _rec and _full is not None and len(_full):
            base = apply_recipe(_full, _rec)
            _scope_feat = _full
        else:
            _scope_feat = feat
    except Exception:
        _scope_feat = feat
    cfg = _EXIT_CFG.get(row.get("hypothesis_id"), {})
    hold = int(cfg.get("hold", row.get("exit_hold", 5)))
    sl = float(cfg.get("sl", row.get("exit_sl", 0.5)))
    tp = float(cfg.get("tp", row.get("exit_tp", 1.0)))
    _tc = cfg.get("trail_cfg") or {"kind": "none"}
    _tc = None if _tc.get("kind") == "none" else _tc
    bmask = base.fillna(False)
    if tr:
        try:
            bmask = bmask & _scope_feat["day"].isin(tr)
        except Exception:
            pass
    if int(bmask.sum()) < min_events:
        return out
    # Level A: independent per-contract ledgers
    per_contract = []
    try:
        _insts = sorted(_scope_feat.loc[bmask, "symbol"].astype(str).unique().tolist())
    except Exception:
        _insts = []
    for _inst in _insts:
        try:
            _m2 = bmask & (_scope_feat["symbol"].astype(str) == _inst)
            if int(_m2.sum()) < 5:
                continue
            _led = _bt(_scope_feat, _m2, hold_bars=hold, sl=sl, tp=tp,
                       trail=None, trail_cfg=_tc, exit_mode="premium",
                       cid="LVLA", verify=False,
                       stop_type=cfg.get("stop_type", "FIXED_PERCENT"),
                       target_type=cfg.get("target_type", "FIXED_PERCENT"),
                       trail_type=cfg.get("trail_type", "NONE"),
                       dataset_split="train_validation")
            registry.count_test(1)
            _mt = _ctm(_led)
            _exp = _scope_feat.loc[_m2, "expiry"].astype(str).mode()
            out["level_A"].append({
                "AGGREGATION_LEVEL": "CONTRACT",
                "symbol": own_id, "contract": _inst,
                "expiry": str(_exp.iloc[0]) if len(_exp) else "?",
                "trades": _mt["trade_count"], "expectancy": _mt["expectancy"],
                "WR": (float((_led["ret"] > 0).mean()) if len(_led) else 0.0)})
        except Exception:
            continue
    # TEST 10: pooled == sum of independent contract ledgers
    try:
        _pooled = _bt(_scope_feat, bmask, hold_bars=hold, sl=sl, tp=tp,
                      trail=None, trail_cfg=_tc, exit_mode="premium",
                      cid="POOL", verify=False)
        registry.count_test(1)
        _ind = [_bt(_scope_feat,
                    bmask & (_scope_feat["symbol"].astype(str) == _a["contract"]),
                    hold_bars=hold, sl=sl, tp=tp, trail=None, trail_cfg=_tc,
                    exit_mode="premium", cid="INDP", verify=False)
                for _a in out["level_A"]]
        for _l in _ind:
            registry.count_test(1)
        out["test10"] = audit_pool_sum(_pooled, _ind)
        out["agg_audit"].append(
            f"EXPECTANCY level=CONTRACT symbol={own_id} "
            f"contracts={len(out['level_A'])} pool_check={out['test10']['pool_sum_match']}")
    except Exception as _e:
        out["test10"] = {"pool_sum_match": "UNTESTABLE", "reason": str(_e)}
    # Level B/C: expiry aggregation
    try:
        import pandas as _pd
        _a = _pd.DataFrame(out["level_A"])
        if len(_a):
            for _ex, _g in _a.groupby("expiry"):
                _pos = [x for x in _g["expectancy"].tolist()
                        if pd.notna(x) and x > 0]
                out["level_B"].append({
                    "AGGREGATION_LEVEL": "EXPIRY", "symbol": own_id,
                    "expiry": str(_ex),
                    "contract_count": int(len(_g)),
                    "positive_fraction": round(len(_pos) / max(1, len(_g)), 4)})
            _n = len(out["level_B"])
            _p = sum(1 for b in out["level_B"] if b["positive_fraction"] >= 0.5)
            out["level_C"] = {"AGGREGATION_LEVEL": "CROSS_EXPIRY",
                             "symbol": own_id,
                             "positive_expiry_fraction": round(_p / max(1, _n), 4),
                             "n_expiries": _n}
    except Exception:
        pass
    # Level D: cross-symbol transfer as a SEPARATE test (never pooled)
    try:
        import json as _j2
        _rec2 = recipe
        if isinstance(_rec2, str):
            _rec2 = _j2.loads(_rec2)
        if isinstance(_rec2, dict) and _rec2:
            for _sid2, _s2 in symbol_store.items():
                if _sid2 == own_id:
                    continue
                _f2 = _s2.get("feat_full")
                if _f2 is None or len(_f2) == 0:
                    continue
                _m3 = apply_recipe(_f2, _rec2).fillna(False)
                _tr2 = (_s2.get("splits", {}).get("discovery", []) or []) + \
                       (_s2.get("splits", {}).get("refinement", []) or [])
                if _tr2:
                    _m3 = _m3 & _f2["day"].isin(_tr2)
                _v = pd.to_numeric(_f2.loc[_m3, "fwd_ret_5m"],
                                   errors="coerce").dropna()
                _le = float(_v.mean()) if len(_v) >= min_events else float("nan")
                _tx = {"AGGREGATION_LEVEL": "CROSS_SYMBOL",
                       "symbol": _sid2, "n": int(len(_v)),
                       "label_expectancy": _le}
                if pd.notna(_le) and len(_v) >= min_events:
                    try:
                        _l2 = _bt(_f2, _m3, hold_bars=hold, sl=sl, tp=tp,
                                  trail=None, trail_cfg=_tc,
                                  exit_mode="premium", cid="XF", verify=False,
                                  dataset_split="train_validation")
                        registry.count_test(1)
                        _tx["trades"] = int(len(_l2))
                        _tx["trade_expectancy"] = float(
                            _l2["ret"].mean()) if len(_l2) else float("nan")
                    except Exception:
                        pass
                out["level_D"].append(_tx)
            _tes = [t.get("trade_expectancy", t.get("label_expectancy"))
                    for t in out["level_D"]]
            _tes = [x for x in _tes
                    if isinstance(x, float) and x == x]
            if _tes:
                out["transfer_expectancy"] = float(max(_tes))
    except Exception:
        pass
    return out


def build_depth1_specs(feat, mods, strikes, lead_cols, min_events, quality):
    """Depth-1 hypothesis specs (iterative list, no recursion). Every spec
    carries a JSON-serializable mask `recipe` so the same research question
    can be re-applied on another universe (full-contract levels, cross-symbol
    transfer) without sharing data."""
    specs = []

    def ok(col, depth=1, primary=True):
        if col not in feat.columns:
            return False
        tier = quality.get(col, "FULL")
        if not allowed_use(tier, depth, primary):
            return False
        return True

    fam_map = {"e_large_ret": ("RAW_OPTION_PRICE", "chain"),
               "e_expansion": ("RAW_OPTION_PRICE", "chain"),
               "e_vol_shock": ("OPTION_VOLUME", "chain"),
               "ev_largeRet_volShock": ("OPTION_VOLUME", "chain"),
               "ev_compress_expand": ("EVENT", "chain"),
               "ev_ret_vol_expand": ("EVENT", "chain"),
               "ev_divergence": ("DIVERGENCE", "chain"),
               "ev_convergence": ("CONVERGENCE", "chain"),
               "ev_catchup_setup": ("CATCHUP", "chain"),
               "e_atm_move": ("CROSS_STRIKE_RELATIONSHIP", "chain")}
    for ec, (fam, rel) in fam_map.items():
        if ec in feat.columns and ok(ec):
            specs.append({"family": fam, "feature": ec, "rel": rel,
                          "mask_fn": lambda f, c=ec: (f[c] == 1),
                          "recipe": {"kind": "atomic", "col": ec,
                                     "op": "eq1"},
                          "depth": 1, "kind": "ATOMIC"})
    for c in lead_cols:
        if c in feat.columns and ok(c) and \
                mods.get("OPTION_TYPE_RELATIONSHIP", ("", ""))[0] == "AVAILABLE":
            specs.append({"family": "OPTION_TYPE_RELATIONSHIP", "feature": c,
                          "rel": "chain",
                          "mask_fn": lambda f, c=c: (f[c] == 1),
                          "recipe": {"kind": "atomic", "col": c,
                                     "op": "eq1"},
                          "depth": 1, "kind": "ATOMIC"})
    if mods.get("STRIKE_RELATIONSHIP", ("", ""))[0] == "AVAILABLE":
        for col in REGISTRY["x_cols"]:
            if "_retdiff" in col and ok(col):
                specs.append({"family": "STRIKE_RELATIONSHIP", "feature": col,
                              "rel": "cross-strike",
                              "mask_fn": lambda f, c=col: (f[c] > 0).fillna(False),
                              "recipe": {"kind": "atomic", "col": col,
                                         "op": "gt0"},
                              "depth": 1, "kind": "ATOMIC"})
    if "breadth_diff" in feat.columns and ok("breadth_diff"):
        specs.append({"family": "CHAIN_BREADTH", "feature": "breadth_diff>0",
                      "rel": "chain",
                      "mask_fn": lambda f: (f["breadth_diff"] > 0).fillna(False),
                      "recipe": {"kind": "atomic", "col": "breadth_diff",
                                 "op": "gt0"},
                      "depth": 1, "kind": "ATOMIC"})
        specs.append({"family": "CHAIN_BREADTH", "feature": "breadth_diff<0",
                      "rel": "chain",
                      "mask_fn": lambda f: (f["breadth_diff"] < 0).fillna(False),
                      "recipe": {"kind": "atomic", "col": "breadth_diff",
                                 "op": "lt0"},
                      "depth": 1, "kind": "ATOMIC"})
    for L in (2, 3):
        col = f"seq{L}"
        if col in feat.columns:
            try:
                vc = feat[col].value_counts()
                for pat in vc[vc >= min_events].head(6).index:
                    specs.append({"family": "SEQUENCE", "feature": f"{col}={pat}",
                                  "rel": "chain",
                                  "mask_fn": lambda f, c=col, p=pat: (f[c] == p),
                                  "recipe": {"kind": "atomic", "col": col,
                                             "op": "eq", "val": str(pat)},
                                  "depth": 1, "kind": "ATOMIC"})
            except Exception:
                pass
    if "state_id" in feat.columns:
        try:
            vc = feat["state_id"].value_counts()
            for sid in vc[vc >= min_events].head(6).index:
                specs.append({"family": "CHAIN_STATE", "feature": f"state={sid}",
                              "rel": "chain",
                              "mask_fn": lambda f, s=sid: (f["state_id"] == s),
                              "recipe": {"kind": "atomic", "col": "state_id",
                                         "op": "eq", "val": str(sid)},
                              "depth": 1, "kind": "ATOMIC"})
        except Exception:
            pass
    return specs


def apply_recipe(feat: pd.DataFrame, recipe: dict):
    """Re-apply a stored mask recipe on another feature universe
    (full-contract levels, cross-symbol transfer). Same research question,
    independent data — never shared observations."""
    if not isinstance(recipe, dict):
        return pd.Series(False, index=feat.index)
    k = recipe.get("kind")
    if k == "atomic":
        col, op = recipe.get("col"), recipe.get("op")
        if col not in feat.columns:
            return pd.Series(False, index=feat.index)
        try:
            if op == "eq1":
                return (feat[col] == 1).fillna(False)
            if op == "gt0":
                return (feat[col] > 0).fillna(False)
            if op == "lt0":
                return (feat[col] < 0).fillna(False)
            if op == "eq":
                return (feat[col].astype(str) == str(recipe.get("val")))
        except Exception:
            return pd.Series(False, index=feat.index)
        return pd.Series(False, index=feat.index)
    if k == "combo":
        m = apply_recipe(feat, recipe.get("parent", {}))
        leg = recipe.get("leg")
        if leg and leg in feat.columns:
            try:
                m = m & (feat[leg] == 1).fillna(False)
            except Exception:
                pass
        return m.fillna(False)
    return pd.Series(False, index=feat.index)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--require-contracts", default=None)
    ap.add_argument("--focus-strikes", type=int, default=3)
    ap.add_argument("--timeframe", default="RAW")
    ap.add_argument("--ranking-objective", default="composite")
    ap.add_argument("--settings-out", default=None)
    ap.add_argument("--splits", default="0.5,0.2,0.3")
    ap.add_argument("--min-events", type=int, default=MIN_EVENTS)
    ap.add_argument("--max-rounds", type=int, default=None)
    ap.add_argument("--max-candidates", type=int, default=None)
    ap.add_argument("--max-runtime-seconds", type=float, default=None)
    ap.add_argument("--resume-from", default=None)
    ap.add_argument("--checkpoint-dir", default=None)
    a = ap.parse_args()
    t_start = time.time()
    engine_error, blocked_reason = "", ""
    final_state = "ENGINE_ERROR"
    try:
        fractions = tuple(float(x) for x in a.splits.split(","))
        settings = DiscoverySettings(
            data_path=a.path, timeframe=a.timeframe, focus_strikes=a.focus_strikes,
            ranking_objective=a.ranking_objective,
            train_frac=fractions[0], validation_frac=fractions[1], oos_frac=fractions[2],
            min_events=a.min_events)
        if a.max_rounds:
            settings.maxRounds = int(a.max_rounds)
        if a.max_candidates:
            settings.maxTotalCandidates = int(a.max_candidates)
            settings.soft_candidate_budget = int(a.max_candidates)
        if a.max_runtime_seconds:
            settings.maxRuntimeSeconds = float(a.max_runtime_seconds)
        if a.resume_from:
            settings.resume_from = a.resume_from
        if a.checkpoint_dir:
            settings.checkpoint_dir = a.checkpoint_dir
        print(f"SETTINGS configuration_hash={settings.configuration_hash()}")
        if a.settings_out:
            import json as _j
            open(a.settings_out, "w").write(_j.dumps(settings.to_dict(), indent=2))
        run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        outdir = a.outdir or os.path.join("xbost_option_discovery", "runs", run_id)
        os.makedirs(outdir, exist_ok=True)
        ckpt_path = os.path.join(a.checkpoint_dir or outdir, "checkpoint.json")

        # ---- 1-3. ingestion / chain / focus (preserved layer) ----
        norm, layout = load_dataset(a.path)
        norm = normalize(norm)
        bar_freq = detect_frequency(norm["timestamp"])
        print(f"BAR_FREQUENCY detected={bar_freq}")
        # ---- instrument identity (§1-§3): canonical series key ----
        # Runs BEFORE resampling so every rolling/forward math is grouped by
        # instrument_id (symbol|expiry|strike|type). Same strike/type across
        # expiries become different instruments with disjoint histories.
        from .identity import assign_instruments
        norm, symbol_status = assign_instruments(norm)
        norm_global = norm.copy()
        _roots = sorted(norm["symbol_id"].astype(str).unique().tolist())
        print(f"SYMBOLS_DETECTED={len(_roots)} {_roots}")
        print(f"SYMBOL_STATUS={symbol_status}")
        if settings.timeframe != "RAW":
            norm = resample_ohlcv(norm, settings.timeframe.lower())
            print(f"RESAMPLED to {settings.timeframe} (instrument-pure)")
            norm_global = norm.copy()
            _roots = sorted(norm["symbol_id"].astype(str).unique().tolist())
        if a.require_contracts:
            _universe = set(norm["symbol"].astype(str).tolist())
            exp = [s.strip() for s in a.require_contracts.split(",")]
            missing = [c for c in exp if c not in _universe]
            for c in exp:
                print(f"  {'FOUND' if c in _universe else 'MISSING'}: {c}")
            if missing:
                print("OPTION_INGESTION_STATUS = FAIL\nDISCOVERY_STARTED = NO")
                blocked_reason = f"missing required contracts {missing}"
                raise SystemExit(f"FAIL: missing {missing}")
        symbol_frames = [(s, norm[norm["symbol_id"].astype(str) == s].copy())
                         for s in _roots]
        # shared global research state (§30/§31): ONE registry, ONE test
        # counter across symbols; frontiers/convergence run per symbol below
        hreg = HypothesisRegistry()
        ctrl = SearchController(settings, t_start=t_start)
        all_rows = []
        all_discoveries = []
        n_round = 0
        leak_by_symbol = {}
        wf_by_symbol = {}
        ll_frames = []
        fq_by_symbol = {}
        symbol_store = {}
        symbol_metas = {}
        prop_by_symbol = {}
        symbol_health = {}
        symbol_ok = {}
        from .exits import reset_audit as _reset_exit_audit
        _reset_exit_audit()
        for _sym_idx, (_sym_id, _sym_norm) in enumerate(symbol_frames):
            norm = _sym_norm
            sym_id = _sym_id
            print(f"===== SYMBOL {_sym_id} "
                  f"({_sym_idx + 1}/{len(symbol_frames)}) "
                  f"INDEPENDENT DISCOVERY =====")
            meta = detect_chain(norm)
            print("OPTIONS_INGESTION_AUDIT\n-----------------------")
            print(f"source_file: {a.path}\nlayout: {layout}\nrows: {len(norm)}")
            registry = build_registry(norm, layout)
            reg_by_sym = {r["contract_id"]: r for r in registry}
            n_ps = sum(1 for r in registry if str(r["strike"]) != "nan" and r["strike"] != "UNKNOWN")
            n_pt = sum(1 for r in registry if r["option_type"] != "UNKNOWN")
            print("CONTRACT_PARSER_AUDIT")
            print(f"detected_contracts={len(registry)} parsed_strikes={n_ps} parsed_types={n_pt}")
            n_pu = sum(1 for r in registry if r["underlying"] != "UNKNOWN")
            from collections import Counter as _Counter
            _usrc = _Counter(r["underlying"] if r["underlying"] != "UNKNOWN" else "none"
                             for r in registry)
            print(f"UNDERLYING_AUDIT detected={len(registry)} parsed={n_pu} "
                  f"unknown={len(registry) - n_pu} failed=0 source={dict(_usrc)} "
                  f"status={'PARSED' if n_pu == len(registry) else ('UNKNOWN_SOURCE' if n_pu == 0 else 'PARTIAL')}")
            for sym, rec in reg_by_sym.items():
                m = norm["symbol"].astype(str) == sym
                if str(rec["strike"]) not in ("nan", "UNKNOWN", "None"):
                    norm.loc[m & pd.to_numeric(norm["strike"], errors="coerce").isna(), "strike"] = float(rec["strike"])
                if rec["option_type"] != "UNKNOWN":
                    norm.loc[m & (norm["option_type"].astype(str) == "UNKNOWN"), "option_type"] = rec["option_type"]
                if rec["underlying"] != "UNKNOWN":
                    norm.loc[m & (norm["underlying"].astype(str) == "UNKNOWN"), "underlying"] = rec["underlying"]
            meta = detect_chain(norm)
            meta["registry"] = registry
            print(f"underlying: {meta['underlying']}")
            print(f"contracts: {meta['n_contracts']} {meta['contracts'][:12]}"
                  f"{'...' if meta['n_contracts'] > 12 else ''}")
            print(f"option_types: {meta['option_types']}\nstrikes: {meta['strikes'][:12]}"
                  f"{'...' if meta['n_strikes'] > 12 else ''}\nexpiries: {meta['expiries']}")
            print(f"snapshots: {meta['synchronized_snapshots']} "
                  f"(complete={meta['complete_snapshots']} partial={meta['partial_snapshots']} "
                  f"completeness={meta['completeness']})")
            # require-contracts already checked against the global instrument
            # universe before the symbol loop; per-symbol scope noted here
            print(f"EXPIRIES_WITH_DATA={meta['n_expiries']}")
            print("MULTI_EXPIRY = NOT_AVAILABLE" if meta["n_expiries"] < 2 else "MULTI_EXPIRY = AVAILABLE")

            mods = module_availability(meta)
            if n_pt > 0:
                pass
            elif len(registry) > 0:
                mods["OPTION_TYPE_RELATIONSHIP"] = (
                    "BLOCKED_PARSE", f"option_type extraction failed for {len(registry)}/{len(registry)} contracts")
            if n_ps > 0:
                pass
            elif len(registry) > 0:
                mods["STRIKE_RELATIONSHIP"] = (
                    "BLOCKED_PARSE", f"strike extraction failed for {len(registry)}/{len(registry)} contracts")
            for m, (st, why) in mods.items():
                print(f"{m} = {st}" + (f" ({why})" if why else ""))
            has_bidask = bool(meta.get("has_bidask"))
            exec_model = "EXECUTABLE_PRICE_MODEL" if has_bidask else "RESEARCH_PRICE_MODEL"
            print(f"EXECUTION_MODEL={exec_model} has_bidask={has_bidask}")
            if mods["OPTION_DATA"][0] != "AVAILABLE":
                blocked_reason = "OPTION_DATA unavailable"
                raise SystemExit("DATA_INVALID")
            ready = all(mods[k][0] == "AVAILABLE" for k in ("OPTION_DATA", "CHAIN_STRUCTURE"))
            print(f"OPTIONS_DATA_READY={'YES' if mods['OPTION_DATA'][0] == 'AVAILABLE' else 'NO'}")
            print(f"OPTIONS_CHAIN_READY={'YES' if mods['CHAIN_STRUCTURE'][0] == 'AVAILABLE' else 'NO'}")
            print(f"OPTIONS_RESEARCH_READY={'YES' if ready else 'NO'}")

            focus_exp = meta["expiries"][0] if meta["n_expiries"] == 1 else None
            chain_sub, strikes, chain = select_focus(norm, meta, a.focus_strikes, focus_exp)
            print(f"FOCUS chain ({len(chain)} contracts): {chain}")
            # §13/§14 explicit focus audit: prioritization only, full universe
            # stays available for validation/robustness/transfer
            _all_sym_instruments = sorted(norm["symbol"].astype(str).unique().tolist())
            _non_focus = [c for c in _all_sym_instruments if c not in chain]
            _liq_filter = bool(meta.get("n_strikes") and len(chain) < len(_all_sym_instruments))
            print(f"TOTAL_STRIKES_AVAILABLE={meta.get('n_strikes')} "
                  f"FOCUS_STRIKES={strikes} NON_FOCUS_STRIKES={len(_non_focus)} "
                  f"FOCUS_REASON=most-liquid-strikes-prioritization")
            print(f"LIQUIDITY_FILTER={str(_liq_filter).upper()} "
                  f"EXCLUDED_CONTRACTS={_non_focus[:12]}"
                  f"{'...' if len(_non_focus) > 12 else ''} "
                  f"EXCLUSION_REASON={'focus-prioritization; retained for robustness/transfer' if _non_focus else 'none'}")
            health = data_health(norm, meta, chain)
            print(f"DATA_HEALTH status={health['status']} "
                  f"missing_intervals={health['missing_interval_count']} "
                  f"dup={health['duplicate_timestamp_count']} volcov={health['volume_coverage']}")
            symbol_health[sym_id] = health["status"]
            data_ok = health["status"] in ("DATA_VALID", "DATA_PARTIAL")
            symbol_ok[sym_id] = bool(data_ok)
            if health["status"] == "DATA_INVALID":
                print(f"SYMBOL_SKIPPED={sym_id} reason=DATA_INVALID "
                      f"(other symbols continue)")
                continue

            # ---- 4. features (instrument-pure: grouped by instrument_id) ----
            feat = build_feature_frame(chain_sub, meta, strikes, mods)
            lead_cols = [c for c in feat.columns if "_leads_" in c]
            feat["day"] = pd.to_datetime(feat["timestamp"]).dt.date
            days = sorted(feat["day"].unique().tolist())
            # full-universe frame (§13): every usable contract stays available
            # for levels/robustness/transfer even when discovery prioritizes
            # the focus chain
            _full_sub = norm.copy()
            feat_full = build_feature_frame(_full_sub, meta,
                                            meta.get("strikes", strikes), mods)
            feat_full["day"] = pd.to_datetime(feat_full["timestamp"]).dt.date
            symbol_store[sym_id] = {"feat_full": feat_full}

            splits = chronological_splits(days, fractions)
            if splits is None or mods["OOS_VALIDATION"][0] != "AVAILABLE":
                print("OOS_VALIDATION = UNAVAILABLE (VALIDATION_INSUFFICIENT_DATA)")
                splits = {"discovery": days, "refinement": [], "pseudo_oos": []}
                wf = []
            else:
                wf = walk_forward(days)
                print(f"OOS_VALIDATION=ACTIVE splits="
                      f"{ {k: len(v) for k, v in splits.items()} } wf_folds={len(wf)}")
            wf_by_symbol[sym_id] = [{"symbol_id": sym_id, **w} for w in wf]
            print(f"OOS_FROZEN days={len(splits['pseudo_oos'])} "
                  f"(never used for optimization)")

            from .leakage import audit_lookahead
            la = audit_lookahead(feat)
            print("LOOKAHEAD_AUDIT")
            print(f"  feature_tests={la['feature_tests']} label_tests={la['label_tests']} "
                  f"spot_pass={la['spot_pass']} spot_fail={la['spot_fail']} "
                  f"first_mismatch={la['first_mismatch']} status={la['status']}")
            leak = {"PASS": la["status"] == "PASS", "detail": la}
            leak_by_symbol[sym_id] = leak["PASS"]
            print(f"NO_LOOKAHEAD_TEST={'PASS' if leak['PASS'] else 'FAIL'}")
            if la["status"] == "FAIL_TRUE_LOOKAHEAD":
                blocked_reason = "TRUE_LOOKAHEAD"
                raise SystemExit("BLOCKED_TRUE_LOOKAHEAD")
            if la["status"] == "FAIL_AUDIT_MISMATCH":
                blocked_reason = "AUDIT_MISMATCH"
                raise SystemExit("BLOCKED_AUDIT_MISMATCH")

            # ---- feature quality tiers (§8) ----
            probe_cols = [c for c in
                          ["e_large_ret", "e_expansion", "e_vol_shock", "e_compression",
                           "e_type_accel", "e_atm_move", "ev_largeRet_volShock",
                           "ev_compress_expand", "ev_ret_vol_expand", "ev_divergence",
                           "ev_convergence", "ev_catchup_setup", "breadth_diff",
                           "type_ret_diff", "type_acc_diff", "type_vol_ratio",
                           "type_vol_diff", "type_range_diff"] + lead_cols + REGISTRY["x_cols"]
                          if c in feat.columns]
            fq = audit_features(feat, probe_cols)
            fq_by_symbol[sym_id] = fq
            quality = dict(zip(fq["feature"], fq["tier"])) if len(fq) else {}
            n_disabled = int((fq["tier"] == "DISABLED").sum()) if len(fq) else 0
            print(f"FEATURE_QUALITY features={len(fq)} disabled={n_disabled}")
            for _, r in fq.head(30).iterrows():
                print(f"  {r['feature']}: missing={r['missing_fraction']} tier={r['tier']} "
                      f"usable={r['usable_event_count']}")

            # ---- lead/lag screening (staged, §21) ----
            ll_rows = []
            by_sym = {s: g.set_index("timestamp").sort_index()
                      for s, g in feat.groupby("symbol")}
            for src, tgt in itertools.permutations(sorted(by_sym), 2):
                for k in LAG_WINDOWS:
                    common = by_sym[src].index.intersection(by_sym[tgt].index)
                    s = by_sym[src].reindex(common)["return_5"]
                    t = by_sym[tgt].reindex(common)["fwd_ret_5m"].shift(-k)
                    vals = t[(s.abs() > 1.0)].dropna()
                    if len(vals) >= a.min_events:
                        ll_rows.append({"source": f"{src}|return_5m",
                                        "target": f"{tgt}|forward_return_5m",
                                        "source_contract": src, "target_contract": tgt,
                                        "lag": k, "event_count": len(vals),
                                        "mean_forward_return": float(vals.mean()),
                                        "median_forward_return": float(vals.median()),
                                        "WR": float((vals > 0).mean())})
            ll = pd.DataFrame(ll_rows)
            if len(ll):
                ll["symbol_id"] = sym_id
            ll_frames.append(ll)
            print(f"LEAD_LAG pairs tested: {len(ll_rows)}")

            # ================= ITERATIVE FRONTIER SEARCH (§4) =================
            # NOTE: hreg/ctrl/all_rows/all_discoveries/n_round/EXIT_AUDIT are
            # GLOBAL (shared across symbols, §26/§30/§31);
            # frontier/conv/masks reset per symbol.
            frontier = FrontierQueue(max_family_share=settings.max_family_share)
            conv = ConvergenceChecker(n=settings.convergence_N,
                                      epsilon=settings.convergence_epsilon)
            # BASELINE config exists ONLY as benchmark (§27/§28); evaluation
            # uses discovered or prescribed exits, never a fixed default
            default_exit = None
            depth1 = build_depth1_specs(feat, mods, strikes, lead_cols,
                                        a.min_events, quality)
            print(f"DEPTH1_SPECS={len(depth1)}")
            # seed frontier with depth-1 specs (iterative queue)
            for i, sp in enumerate(depth1):
                reg = hreg.register(f"ATOMIC-{i}", sp["family"], sp["feature"],
                                    contract_scope=sp["rel"], exit_rule="hold5/sl.5/tp1",
                                    depth=1, reason="depth-1-seed")
                frontier.add(reg["hypothesis_id"], sp["family"], sp["feature"], 1,
                             "depth-1-seed")
                frontier.items[reg["hypothesis_id"]]["recipe"] = sp.get("recipe")
            # lead/lag top pairs as depth-1 hypotheses
            if len(ll) and mods["LEAD_LAG"][0] == "AVAILABLE":
                for _, r in ll.reindex(
                        ll["mean_forward_return"].abs().sort_values(
                            ascending=False).index).head(6).iterrows():
                    reg = hreg.register("LEADLAG", "LEAD_LAG",
                                        f"{r['source']}(>1%)@{int(r['lag'])}bar",
                                        contract_scope=f"{r['source_contract']}->{r['target_contract']}",
                                        depth=1, reason="leadlag-screen")
                    tgt_rows = feat[(feat["symbol"] == r["target_contract"]) &
                                    feat["timestamp"].isin(
                                        pd.DatetimeIndex(sorted(by_sym[r["source_contract"]].index)) +
                                                         pd.Timedelta(minutes=int(r["lag"])))]
                    smask = pd.Series(False, index=feat.index)
                    smask.loc[tgt_rows.index] = True
                    frontier.add(reg["hypothesis_id"], "LEAD_LAG",
                                 f"{r['source_contract']}->{r['target_contract']}", 1,
                                 "leadlag-screen")
                    reg["record"]["_ll_mask"] = smask
                    reg["record"]["_ll_params"] = {
                        "source": r["source_contract"],
                        "target": r["target_contract"],
                        "lag": int(r["lag"])}

            spec_by_hid = {}
            for sp in depth1:
                pass  # masks rebuilt from feature col at eval time
            # map atomic hid -> mask builder
            atomic_masks = {}
            # rebuild mapping hid->spec in seed order
            seed_hids = [it["hypothesis_id"] for it in frontier.to_json()]
            depth1_hids = seed_hids[:len(depth1)]
            for hid, sp in zip(seed_hids[:len(depth1)], depth1):
                atomic_masks[hid] = sp

            no_discovery_streak = 0
            mask_cache = {}
            wd = Watchdog(round_timeout_s=600.0, candidate_timeout_s=120.0)
            converged = False
            best_val, best_oos = float("-inf"), float("-inf")
            prev_best_val, prev_best_oos = float("-inf"), float("-inf")
            seen_families = set()
            fam_counts = {}
            fam_rejected = 0
            budget_hit = False
            stop_why = ""

            def _mem():
                try:
                    import psutil as _p
                    return f"{round(_p.Process().memory_info().rss / 1e6, 1)}MB"
                except Exception:
                    return "NA"

            # resume support: per-symbol files (§32); global counters and
            # rows restored once, filtered by symbol to avoid duplication
            _rpath = (settings.resume_from + f".{sym_id}.checkpoint.json"
                      if settings.resume_from and not settings.resume_from.endswith(".json")
                      else (settings.resume_from or ""))
            if not _rpath or not os.path.exists(_rpath):
                _rpath = settings.resume_from if settings.resume_from and os.path.exists(
                    settings.resume_from or "") else ""
            if _rpath and os.path.exists(_rpath):
                cp = load_checkpoint(_rpath)
                for r in cp.get("candidates", []):
                    if r.get("symbol_id", sym_id) == sym_id and r not in all_rows:
                        all_rows.append(r)
                frontier.load(cp.get("frontier", []))
                hreg.global_test_count = max(
                    hreg.global_test_count, int(cp.get("global_test_count", 0)))
                hreg.n = max(hreg.n, int(cp.get("hypothesis_n", hreg.n)))
                n_round = max(n_round, int(cp.get("round", 0)))
                _reg = cp.get("registry", {})
                for _hid, _rec in (_reg.get("hypotheses") or {}).items():
                    _rec.pop("_ll_mask", None)
                    hreg.hypotheses[_hid] = _rec
                    hreg.by_signature[_rec.get("signature", _hid)] = _hid
                    if _rec.get("canonical_hash"):
                        hreg.by_hash.setdefault(_rec["canonical_hash"], _hid)
                        hreg.clone_groups.setdefault(
                            _rec["canonical_hash"], []).append(_hid)
                for _k, _v in (_reg.get("memory") or {}).items():
                    if _k in hreg.memory:
                        hreg.memory[_k] = hreg.memory[_k].union(set(_v))
                hreg.duplicate_count = max(hreg.duplicate_count,
                                           int(_reg.get("duplicates", 0)))
                hreg.clone_count = max(hreg.clone_count,
                                       int(_reg.get("clones", 0)))
                for _d in cp.get("discoveries", []):
                    if _d.get("symbol_id", sym_id) == sym_id and \
                            _d not in all_discoveries:
                        all_discoveries.append(_d)
                for _it in sorted(frontier.to_json(),
                                  key=lambda x: x.get("combination_depth", 1)):
                    if _it["status"] == "QUEUED":
                        try:
                            mask_cache[_it["hypothesis_id"]] = _resolve_mask(
                                feat, _it["hypothesis_id"], hreg, atomic_masks,
                                mask_cache, frontier)
                        except Exception:
                            pass
                print(f"RESUMED_FROM_CHECKPOINT round={n_round} "
                      f"candidates={len(all_rows)} tests={hreg.global_test_count}")

            while True:
                n_cands = len(all_rows)
                fsize = frontier.size()
                eff_limit = ctrl.effective_candidate_limit(fsize, n_cands)
                stop, why = ctrl.should_stop(n_round, n_cands, fsize, converged)
                if n_cands >= eff_limit and not ctrl.may_expand_budget(fsize):
                    stop, why = True, "CANDIDATE_BUDGET"
                if stop:
                    budget_hit = (not converged) and (fsize > 0) and why not in (
                        "CONVERGED", "SOFT_BUDGET_CONVERGED")
                    if why in ("HARD_ROUND_CEILING", "HARD_CANDIDATE_CEILING",
                               "RUNTIME_EXHAUSTED", "CANDIDATE_BUDGET", "BUDGET_NO_REMAINING"):
                        budget_hit = (fsize > 0 and not converged)
                    stop_why = why
                    break
                n_round += 1
                round_fam = {}  # per-round quota counters (§7: quota per round batch)
                batch = frontier.pop_batch(min(settings.maxEvaluationBatch,
                                               settings.maxRawCandidatesPerRound),
                                           fam_counts)
                if not batch and frontier.size() > 0:
                    # family stops starved the batch while work remains: lift
                    # stops and repop rather than burning a round (§7/§21)
                    frontier.stopped_families = set()
                    batch = frontier.pop_batch(
                        min(settings.maxEvaluationBatch,
                            settings.maxRawCandidatesPerRound), fam_counts)
                # batch-proportional quota: each family may take at most
                # max_family_share of the round batch (min 1 slot); excess items
                # are deferred only when another family is present in the batch.
                from collections import Counter as _C
                _fam_in_batch = _C(it["family"] for it in batch)
                _allowed = {f: max(1, int(settings.max_family_share * len(batch)))
                            for f in _fam_in_batch}
                _batch_idx = {id(it): i for i, it in enumerate(batch)}
                # exploration/exploitation split (§26/§45): 70/30 with family-diverse exploration
                n_explore = max(1, int(len(batch) * settings.minimumExplorationFraction)) \
                    if batch else 0
                new_hyps, dup_hyps, explore_ct, exploit_ct = 0, 0, 0, 0
                clone_hyps, skipped_small = 0, 0
                robust_tested, robust_passed = 0, 0
                oos_raw_pos, oos_thr_pass, exit_cands, trading_cands = 0, 0, 0, 0
                round_discoveries = []
                added = 0
                round_timeout_hit = False
                frontier_before = frontier.size()
                wd.start_round()
                round_best_val, round_best_oos, round_best_tr, round_best_rob = (
                    float("-inf"), float("-inf"), float("-inf"), float("-inf"))
                new_fams = set()
                for item in batch:
                    hid = item["hypothesis_id"]
                    wd.start_candidate()
                    if wd.round_expired():
                        item["status"] = "QUEUED"
                        round_timeout_hit = True
                        break
                    item["status"] = "EVALUATING"
                    fam = item["family"]
                    # family quota (§7) against the round batch allowance: defer
                    # the excess only when an alternative family waits in-batch.
                    # Deferred items stay QUEUED for later rounds (no starvation).
                    if round_fam.get(fam, 0) >= _allowed.get(fam, 1):
                        alt_in_batch = any(
                            it["family"] != fam and it["status"] == "QUEUED"
                            for it in batch[_batch_idx[id(item)] + 1:])
                        alt_queued = any(
                            it["status"] == "QUEUED" and it["family"] != fam
                            for it in frontier.items.values())
                        if alt_in_batch or alt_queued:
                            fam_rejected += 1
                            item["status"] = "QUEUED"  # re-queue, not drop
                            continue
                    fam_counts[fam] = fam_counts.get(fam, 0) + 1
                    round_fam[fam] = round_fam.get(fam, 0) + 1
                    hreg.count_test(1)
                    # resolve mask (iterative helper; see _resolve_mask)
                    m = _resolve_mask(feat, hid, hreg, atomic_masks, mask_cache,
                                      frontier)
                    if m is None or m.sum() < a.min_events:
                        item["status"] = "REJECTED"
                        skipped_small += 1
                        continue
                    mask_cache[hid] = m
                    rec = hreg.hypotheses.get(hid, {})
                    rec["recipe"] = item.get("recipe")
                    depth = int(rec.get("combination_depth", item.get("combination_depth", 1)))
                    do_exit = depth <= 2  # exit discovery on promising shallow events
                    exit_cfg = item.get("exit_cfg") or default_exit
                    row = evaluate_candidate(
                        feat, m, hid, fam, item.get("feature_signature", hid),
                        "fwd_ret_5m", rec.get("contract_scope", "chain"), "long", "5m",
                        splits, settings, a.min_events, rec or {"hypothesis_id": hid},
                        depth, exit_cfg, has_bidask, do_exit, True, hreg)
                    if row is None:
                        item["status"] = "REJECTED"
                        continue
                    if wd.candidate_expired():
                        print(f"SLOW_CANDIDATE {hid} exceeded "
                              f"{wd.candidate_timeout_s:.0f}s")
                    new_hyps += 1
                    if item.get("reason_added", "").startswith("explore"):
                        explore_ct += 1
                    else:
                        exploit_ct += 1
                    all_rows.append(row)
                    item["status"] = "EVALUATED"
                    # discovery record (§3): only genuinely new, non-clone
                    # hypotheses count as discoveries (§5, §21)
                    _is_clone = bool(hreg.hypotheses.get(hid, {}).get("is_clone"))
                    clone_hyps += int(_is_clone)
                    robust_tested += 1
                    robust_passed += int(row["robustness_score"] >= 4.0)
                    trading_cands += 1
                    exit_cands += int(bool(row.get("exit_search_best")))
                    try:
                        _oe = float(row["OOS_expectancy"])
                    except (TypeError, ValueError):
                        _oe = float("nan")
                    if _oe == _oe and _oe > 0:
                        oos_raw_pos += 1
                        if int(row["OOS_events"] or 0) >= settings.min_oos_events:
                            oos_thr_pass += 1
                    if not _is_clone:
                        _dcat = discovery_category({
                            "FWD_expectancy": row["FWD_expectancy"],
                            "FWD_IS_expectancy": row["FWD_IS_expectancy"],
                            "IS_expectancy": row["IS_expectancy"],
                            "robustness_score": row["robustness_score"],
                            "OOS_trading_result": row["OOS_trading_result"],
                            "mt_pass": "False",
                            "execution_model": row["execution_model"],
                            "paper_eligible": False})
                        _disc = {
                            "discovery_id": f"D{n_round:03d}-{hid}",
                            "cycle_id": n_round, "symbol_id": sym_id,
                            "hypothesis_id": hid,
                            "family": fam,
                            "hypothesis_definition": row["feature_definition"],
                            "parent_hypothesis": row["parent_ids"],
                            "new_information": row["failure_why"]
                            if _dcat == "NO_DISCOVERY"
                            else f"{_dcat}:{row['return_path_class']}",
                            "is_clone": False,
                            "sample_size": int(row["events"]),
                            "train_result": row["FWD_expectancy"],
                            "validation_result": row["FWD_IS_expectancy"],
                            "OOS_result": row["OOS_trading_result"],
                            "status": _dcat,
                            "trading_rule": row["exit_rule"],
                            "exit": row["exit_search_best"],
                            "robustness": row["robustness_score"],
                            "edge_level": _dcat}
                        round_discoveries.append(_disc)
                        all_discoveries.append(_disc)
                    item["validation_score"] = row["FWD_IS_expectancy"] \
                        if pd.notna(row["FWD_IS_expectancy"]) else 0.0
                    item["train_score"] = row["FWD_expectancy"] \
                        if pd.notna(row["FWD_expectancy"]) else 0.0
                    try:
                        item["OOS_score"] = float(row["OOS_expectancy"] or 0.0)
                    except (TypeError, ValueError):
                        item["OOS_score"] = 0.0
                    item["robustness_score"] = row["robustness_score"]
                    for k, v in (("val", row["FWD_IS_expectancy"]),
                                 ("oos", row["OOS_expectancy"]),
                                 ("tr", row["FWD_expectancy"]),
                                 ("rob", row["robustness_score"])):
                        try:
                            v = float(v)
                        except (TypeError, ValueError):
                            continue
                        if v == v:
                            if k == "val":
                                round_best_val = max(round_best_val, v)
                            elif k == "oos":
                                round_best_oos = max(round_best_oos, v)
                            elif k == "tr":
                                round_best_tr = max(round_best_tr, v)
                            else:
                                round_best_rob = max(round_best_rob, v)
                    if fam not in seen_families:
                        new_fams.add(fam)
                        seen_families.add(fam)
                    # promote to frontier children (§26 iterative, depth-capped)
                    promising = pd.notna(row["FWD_IS_expectancy"]) and \
                        row["FWD_IS_expectancy"] > 0 and row["events"] >= a.min_events
                    if promising and depth < settings.maxCombinationDepth:
                        # top diverse confirmation legs (not yet dominant)
                        legs = [c for c in
                                ["e_expansion", "e_vol_shock", "e_compression",
                                 "ev_divergence", "ev_convergence", "ev_catchup_setup"]
                                if c in feat.columns and c != row["feature_definition"]]
                        # §5: never re-add a leg already in the parent signature —
                        # X&leg where leg ∈ X is the same signal, not a discovery
                        _parent_tokens = set(
                            row["feature_definition"].split("&"))
                        legs = [lg for lg in legs if lg not in _parent_tokens]
                        added = 0
                        for leg in legs[:settings.topKConditional]:
                            if added >= 3:
                                break
                            reg2 = hreg.register(
                                "COMBO", "COMBINATION",
                                f"{row['feature_definition']}&{leg}",
                                contract_scope=rec.get("contract_scope", "chain"),
                                exit_rule="hold5/sl.5/tp1",
                                parent_ids=[hid], depth=depth + 1,
                                reason=f"combo-confirm:{leg}", cycle_id=n_round)
                            if not reg2["duplicate"]:
                                it2 = {"hypothesis_id": reg2["hypothesis_id"],
                                       "family": "COMBINATION",
                                       "feature_signature": f"{row['feature_definition']}&{leg}",
                                       "combination_depth": depth + 1,
                                       "reason_added": f"combo-confirm:{leg}",
                                       "confirm_feature": leg,
                                       "recipe": {"kind": "combo",
                                                  "parent": frontier.items.get(
                                                      hid, {}).get("recipe"),
                                                  "leg": leg},
                                       "train_score": 0.0, "validation_score": 0.0,
                                       "OOS_score": 0.0, "robustness_score": 0.0,
                                       "priority": 0.0, "status": "QUEUED",
                                       "parent_hypotheses": [hid],
                                       "information_gain": 0.0, "novelty": 1.0}
                                frontier.items[reg2["hypothesis_id"]] = it2
                                mask_cache[reg2["hypothesis_id"]] = (
                                    m & (feat[leg] == 1).fillna(False))
                                hreg.hypotheses[reg2["hypothesis_id"]]["parent_ids"] = [hid]
                                added += 1
                            else:
                                dup_hyps += 1
                        frontier.set_status(hid, "PROMOTED")
                    else:
                        frontier.set_status(hid, "EVALUATED")
                    # failure-driven exit variants (§22, FIX 4): predictive signal
                    # with no working trading rule spawns NEW hypotheses carrying
                    # alternative exit structures into the next cycle's queue.
                    if row["unresolved_code"] in (
                            "ENTRY_PROMISING_EXIT_UNRESOLVED",
                            "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED"):
                        try:
                            import json as _jj
                            _best = _jj.loads(row["exit_search_best"]) \
                                if isinstance(row["exit_search_best"], str) else {}
                            if isinstance(_best, str):
                                _best = _jj.loads(_best)
                        except Exception:
                            _best = {}
                        _alts = []
                        if isinstance(_best, dict) and _best:
                            _alts.append({"hold": _best.get("hold", 5),
                                          "sl": 99.0, "tp": 99.0,
                                          "trail_cfg": {"kind": "none"},
                                          "stop_type": "NONE",
                                          "target_type": "NONE",
                                          "trail_type": "NONE",
                                          "note": "time-only-hold"})
                            _alts.append({"hold": _best.get("hold", 5),
                                          "sl": _best.get("sl", 0.5), "tp": 99.0,
                                          "trail_cfg": {"kind": "none"},
                                          "stop_type": _best.get("stop_type",
                                                                 "FIXED_PERCENT"),
                                          "target_type": "NONE",
                                          "trail_type": "NONE",
                                          "note": "hold+stop"})
                        for _ax in _alts[:2]:
                            _er = (f"hold={_ax['hold']}/sl={_ax['sl']}/"
                                   f"tp={_ax['tp']}/trail={_ax['trail_cfg']}")
                            regx = hreg.register(
                                "EXITVAR", fam, row["feature_definition"],
                                contract_scope=rec.get("contract_scope", "chain"),
                                entry_rule=rec.get("entry_rule", "signal-close"),
                                exit_rule=_er, parent_ids=[hid], depth=depth,
                                reason=f"exit-variant:{_ax['note']}",
                                cycle_id=n_round)
                            if not regx["duplicate"]:
                                itx = {"hypothesis_id": regx["hypothesis_id"],
                                       "family": fam,
                                       "feature_signature": row["feature_definition"],
                                       "combination_depth": depth,
                                       "reason_added": f"exit-variant:{_ax['note']}",
                                       "reason_promising": row["failure_why"],
                                       "reason_unresolved": row["unresolved_code"],
                                       "unresolved_code": row["unresolved_code"],
                                       "next_action": "exit-discovery",
                                       "recipe": frontier.items.get(
                                           hid, {}).get("recipe"),
                                       "exit_cfg": {k: _ax[k] for k in
                                                    ("hold", "sl", "tp",
                                                     "trail_cfg", "stop_type",
                                                     "target_type", "trail_type")},
                                       "train_score": 0.0, "validation_score": 0.0,
                                       "OOS_score": 0.0, "robustness_score": 0.0,
                                       "priority": 0.0, "status": "QUEUED",
                                       "parent_hypotheses": [hid],
                                       "information_gain": 0.0, "novelty": 1.2}
                                frontier.items[regx["hypothesis_id"]] = itx
                                mask_cache[regx["hypothesis_id"]] = m
                                added += 1
                            else:
                                dup_hyps += 1
                    # research-memory buckets (§4)
                    _cat0 = "promising" if (
                        pd.notna(row["FWD_IS_expectancy"])
                        and row["FWD_IS_expectancy"] > 0) else "rejected"
                    hreg.mark(hid, _cat0)
                    if row["OOS_trading_result"] != "OOS_TRADING_RULE_PASS" \
                            and pd.notna(row["FWD_OOS_expectancy"]) \
                            and row["FWD_OOS_expectancy"] > 0:
                        hreg.mark(hid, "oos_rejected")
                    if row["unresolved_code"]:
                        hreg.mark(hid, "exit_unresolved")
                    if row["robustness_score"] >= 4.0:
                        hreg.mark(hid, "robust")
                # exploration seeding (§26): family-diverse probes while budget remains
                n_new_fam = len(new_fams)
                fsize = frontier.size()
                # diversity saturated (§5/§7): no QUEUED family is unexplored, or
                # the evaluated mix already spans families without dominance
                queued_fams = {it["family"] for it in frontier.items.values()
                               if it["status"] == "QUEUED"}
                div_sat = (not queued_fams) or \
                    all(f in seen_families for f in queued_fams)
                dval = (round_best_val - prev_best_val) \
                    if prev_best_val != float("-inf") and round_best_val != float("-inf") else 0.0
                doos = (round_best_oos - prev_best_oos) \
                    if prev_best_oos != float("-inf") and round_best_oos != float("-inf") else 0.0
                if round_best_val != float("-inf"):
                    prev_best_val = max(prev_best_val, round_best_val)
                    best_val = max(best_val, round_best_val)
                if round_best_oos != float("-inf"):
                    prev_best_oos = max(prev_best_oos, round_best_oos)
                    best_oos = max(best_oos, round_best_oos)
                # family hard-stop >50% for next cycle (§7)
                fam_total = max(1, sum(fam_counts.values()))
                stopped = frontier.update_family_stops(fam_counts, fam_total)
                # exit / trading-rule research exhausted? (§25)
                exit_open = sum(1 for it in frontier.items.values()
                                if it.get("unresolved_code")
                                in ("ENTRY_PROMISING_EXIT_UNRESOLVED",
                                    "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED")
                                and it["status"] == "QUEUED")
                exit_exhausted = (exit_open == 0)
                trading_exhausted = (fsize == 0)
                converged = conv.update(fsize, n_new_fam, dval, doos, div_sat,
                                        exit_exhausted, trading_exhausted,
                                        best_train_delta=round_best_tr
                                        if round_best_tr != float("-inf") else 0.0)
                # cycle status (§1/§21)
                if round_timeout_hit:
                    cycle_status = "CYCLE_BUDGET_EXHAUSTED"
                elif round_discoveries:
                    cycle_status = "CYCLE_DISCOVERY_FOUND"
                    no_discovery_streak = 0
                else:
                    cycle_status = "CYCLE_NO_NEW_DISCOVERY"
                    no_discovery_streak += 1
                # automatic direction change on no-discovery (§21/§22): lift
                # family stops, boost exploration, reprioritize unseen families
                if cycle_status == "CYCLE_NO_NEW_DISCOVERY":
                    frontier.stopped_families = set()
                    for it in frontier.items.values():
                        if it["status"] == "QUEUED" \
                                and it["family"] not in seen_families:
                            it["novelty"] = 2.0
                next_plan = build_next_cycle_plan(
                    frontier, fam_counts, seen_families, stopped,
                    [d["discovery_id"] for d in all_discoveries])
                fam_share_after = {k: round(v / max(1, sum(fam_counts.values())), 3)
                                   for k, v in fam_counts.items()}
                dom = max(fam_share_after.values()) if fam_share_after else 0.0
                print(f"ROUND {n_round} [{cycle_status}] candidates={len(all_rows)} "
                      f"new={new_hyps} dup={dup_hyps} clones={clone_hyps} "
                      f"skipped_small={skipped_small} frontier={fsize} "
                      f"added={added if batch else 0} removed={len(batch)} "
                      f"best_tr={round_best_tr:.4f} best_val={round_best_val:.4f} "
                      f"best_oos={round_best_oos:.4f} best_rob={round_best_rob:.4f} "
                      f"new_fam={n_new_fam} explore={explore_ct} exploit={exploit_ct} "
                      f"runtime={ctrl.elapsed():.0f}s mem={_mem()} "
                      f"tests={hreg.global_test_count} fam_reject={fam_rejected} "
                      f"dominant_share={dom:.2f} stopped={sorted(stopped)}")
                ctrl.round_logs.append({"round": n_round,
                                        "cycle_id": n_round,
                                        "cycle_status": cycle_status,
                                        "candidate_count": len(all_rows),
                                        "hypotheses_generated": new_hyps + dup_hyps,
                                        "hypotheses_new": new_hyps,
                                        "hypotheses_duplicate": dup_hyps,
                                        "hypotheses_clones": clone_hyps,
                                        "hypotheses_skipped_small": skipped_small,
                                        "families_explored": sorted(seen_families),
                                        "families_blocked": sorted(stopped),
                                        "frontier_before": frontier_before,
                                        "frontier_after": fsize,
                                        "frontier_size": fsize, "converged": converged,
                                        "train_candidates": trading_cands,
                                        "validation_candidates": trading_cands,
                                        "OOS_candidates": trading_cands,
                                        "OOS_positive": oos_raw_pos,
                                        "OOS_threshold_pass": oos_thr_pass,
                                        "OOS_final_survivors": 0,
                                        "robustness_tested": robust_tested,
                                        "robustness_passed": robust_passed,
                                        "multiple_testing_count": hreg.global_test_count,
                                        "multiple_testing_survivors": 0,
                                        "trading_rule_candidates": trading_cands,
                                        "exit_candidates": exit_cands,
                                        "new_discoveries": len(round_discoveries),
                                        "runtime": round(ctrl.elapsed(), 1),
                                        "memory": wd.memory_mb(),
                                        "stop_why": ""})
                # multi-file checkpoints (§28)
                ckpt_base = a.checkpoint_dir or outdir
                mem = {k: sorted(v) for k, v in hreg.memory.items()}
                _hyps = {}
                for _hid, _rec in hreg.hypotheses.items():
                    _r = {k: v for k, v in _rec.items() if k != "_ll_mask"}
                    _r["signature"] = hreg.signature(
                        _rec.get("feature_signature", ""),
                        _rec.get("timestamp_rule", ""),
                        _rec.get("label", ""), _rec.get("direction", ""),
                        _rec.get("contract_scope", ""),
                        _rec.get("entry_rule", ""),
                        _rec.get("exit_rule", ""))
                    _hyps[_hid] = _r
                _registry = {"hypotheses": _hyps, "memory": mem,
                             "duplicates": hreg.duplicate_count,
                             "clones": hreg.clone_count,
                             "families": dict(fam_counts)}
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.checkpoint.json"), {
                    "run_id": run_id, "round": n_round,
                    "candidates": all_rows[-500:],
                    "discoveries": all_discoveries[-500:],
                    "frontier": frontier.to_json(),
                    "registry": _registry,
                    "global_test_count": hreg.global_test_count,
                    "hypothesis_n": hreg.n, "oos_days": [str(d) for d in splits["pseudo_oos"]],
                    "config_hash": settings.configuration_hash(),
                    "random_seed": settings.random_seed})
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.research_registry.json"), {
                    "hypotheses_tested": len(hreg.hypotheses),
                    "registry": _registry,
                    "global_test_count": hreg.global_test_count})
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.frontier.json"),
                                frontier.to_json())
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.candidate_store.json"),
                                all_rows[-1000:])
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.oos_store.json"), {
                    "oos_days": [str(d) for d in splits["pseudo_oos"]],
                    "OOS_FROZEN": True, "OOS_REOPTIMIZED": False})
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.exit_store.json"), {
                    "exit_unresolved": hreg.memory["exit_unresolved"] and
                    sorted(hreg.memory["exit_unresolved"])})
                save_checkpoint(os.path.join(ckpt_base, f"{sym_id}.robustness_store.json"), {
                    "robust": sorted(hreg.memory["robust"])})
                with open(os.path.join(ckpt_base, f"{sym_id}.discoveries.jsonl"), "a") as _df:
                    import json as _jj2
                    for _d in round_discoveries:
                        _df.write(_jj2.dumps(_d, default=str) + "\n")
                # per-cycle discovery report (§31)
                print(f"===== DISCOVERY CYCLE {n_round} =====")
                if round_discoveries:
                    _top = max(round_discoveries,
                               key=lambda d: (d["status"] != "NO_DISCOVERY",
                                              float(d["validation_result"] or -1e18)
                                              if str(d["validation_result"]) not in
                                              ("NA", "nan") else -1e18))
                    print(f"NEW DISCOVERY: ID={_top['discovery_id']} "
                          f"FAMILY={_top['family']} DESC={_top['hypothesis_definition']} "
                          f"WHY_NEW={_top['new_information']} "
                          f"TRAIN={_top['train_result']} VAL={_top['validation_result']} "
                          f"OOS={_top['OOS_result']} ROB={_top['robustness']} "
                          f"RULE={_top['trading_rule']} EXIT={_top['exit']} "
                          f"EDGE={_top['edge_level']}")
                print(f"FRONTIER: {fsize} items "
                      f"({len(next_plan['top_unresolved'])} prioritized)")
                print(f"NEXT SEARCH: explore={next_plan['families_needing_exploration'][:5]} "
                      f"over={next_plan['families_over_explored'][:5]} "
                      f"exit_tests={next_plan['new_exit_tests']}")
                print(f"STATUS: {cycle_status}")
                if not wd.memory_ok():
                    print(f"WARNING memory budget exceeded: {wd.memory_mb():.0f}MB")
                if not batch and fsize == 0:
                    stop_why = "FRONTIER_DRAINED"
                    if conv.drain_converged():
                        converged = True
                    break
            # ---- per-symbol state handoff (§4): independent frames stored
            # for global assembly (levels, transfer, boards, audits)
            _handoff = {"feat": feat, "masks": dict(mask_cache),
                        "splits": splits, "meta": meta,
                        "mods": mods, "health": health,
                        "chain": chain, "strikes": strikes,
                        "has_bidask": has_bidask,
                        "exec_model": exec_model,
                        "frontier": frontier.to_json(),
                        "depth1_hids": list(depth1_hids),
                        "converged": converged,
                        "stop_why": stop_why,
                        "budget_hit": budget_hit,
                        "frontier_size": frontier.size()}
            _handoff.update(symbol_store.get(sym_id, {}))
            symbol_store[sym_id] = _handoff
            symbol_metas[sym_id] = meta
            prop_by_symbol[sym_id] = None  # filled by post-search gate
        # ================= POST-SEARCH (global assembly) =================
        # terminal-space bookkeeping (§31/§37) aggregated across symbols:
        # converged only if every executed symbol converged; budget hit if
        # any symbol hit it; frontier = sum of per-symbol frontiers.
        _sym_terms = [v for v in symbol_store.values() if "stop_why" in v]
        _all_front = sum(v.get("frontier_size", 0) for v in _sym_terms)
        _all_conv = all(v.get("converged", False) for v in _sym_terms) \
            if _sym_terms else False
        _any_budget = any(v.get("budget_hit", False) for v in _sym_terms)
        _stop_whys = sorted({v.get("stop_why", "") for v in _sym_terms})
        stop_why = "+".join(w for w in _stop_whys if w) or "LOOP_END"
        budget_hit = bool(_any_budget)
        converged = bool(_all_conv)
        _d1_terminal = all(
            all(it.get("hypothesis_id") != h or it.get("status")
                in ("EVALUATED", "REJECTED", "PROMOTED")
                for it in v.get("frontier", []) for h in v.get("depth1_hids", []))
            for v in _sym_terms) if _sym_terms else False
        _exit_left = any(
            it.get("unresolved_code")
            in ("ENTRY_PROMISING_EXIT_UNRESOLVED",
                "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED")
            and it["status"] == "QUEUED"
            for v in _sym_terms for it in v.get("frontier", []))
        space_exhausted = bool(_all_front == 0 and _d1_terminal
                               and not _exit_left)
        search_completed = bool(_all_front == 0 and all(
            w not in ("HARD_ROUND_CEILING", "HARD_CANDIDATE_CEILING",
                      "RUNTIME_EXHAUSTED") for w in _stop_whys))
        data_ok = any(symbol_ok.values()) if symbol_ok else False
        # global frames: lead/lag + walk-forward concatenated with symbol tags
        ll = pd.concat([f for f in ll_frames if len(f)], ignore_index=True) \
            if any(len(f) for f in ll_frames) else pd.DataFrame()
        wf = [w for v in wf_by_symbol.values() for w in v]
        leak = {"PASS": all(leak_by_symbol.values()) if leak_by_symbol else False,
                "by_symbol": dict(leak_by_symbol)}
        cands_df = pd.DataFrame(all_rows)
        if len(cands_df):
            cands_df["perm_p_adj"] = bh(cands_df["perm_p"].fillna(1).values)
            try:
                cands_df["perm_p_holm"] = holm(cands_df["perm_p"].fillna(1).values)
                cands_df["perm_p_bonf"] = bonferroni(cands_df["perm_p"].fillna(1).values)
            except Exception:
                cands_df["perm_p_holm"] = cands_df["perm_p_adj"]
                cands_df["perm_p_bonf"] = cands_df["perm_p_adj"]
            cands_df["mt_pass"] = (cands_df["perm_p_adj"] < 0.10).astype(str)
            for obj, col in [("sharpe", "IS_TRADE_SHARPE"), ("expectancy", "FWD_expectancy"),
                             ("pf", "FWD_PF"), ("oos", "FWD_OOS_expectancy"),
                             ("robustness", "robustness_score")]:
                v = pd.to_numeric(cands_df[col], errors="coerce")
                cands_df[f"rank_{obj}"] = v.rank(pct=True)
            cands_df["rank_composite"] = cands_df[
                ["rank_sharpe", "rank_expectancy", "rank_oos", "rank_robustness"]].mean(axis=1)
            # paper gate per candidate (§56/§47): execution + lookahead
            # resolved per row's own symbol (never pooled)
            if "symbol_id" in cands_df:
                cands_df["lookahead_pass"] = cands_df["symbol_id"].map(
                    lambda s: str(bool(leak_by_symbol.get(s, False))))
            else:
                cands_df["lookahead_pass"] = str(bool(leak.get("PASS")))
            pe, per_ = [], []
            for _, r in cands_df.iterrows():
                _hb = str(r.get("execution_model")) == "EXECUTABLE_PRICE_MODEL"
                e, why = paper_eligible(r.to_dict(), _hb)
                pe.append(e)
                per_.append(why)
            cands_df["paper_eligible"] = pe
            cands_df["paper_gate_reason"] = per_
            # discovery category + §20 L1-L8 levels + OOS stage (FIX 2)
            cats, lvls, stages = [], [], []
            for _, r in cands_df.iterrows():
                d = r.to_dict()
                c = discovery_category(d)
                cats.append(c)
                lvls.append(str(edge_levels_l1_l8(d)["levels"]))
                _st = oos_stage(d.get("OOS_expectancy"), d.get("OOS_events"),
                                settings.min_oos_events, d.get("mt_pass"),
                                robust_pass=(float(d.get("robustness_score") or 0)
                                             >= 4.0))
                stages.append(oos_final_survivor(
                    _st, d.get("paper_eligible") is True))
            cands_df["discovery_category"] = cats
            cands_df["edge_levels_l1_l8"] = lvls
            cands_df["OOS_stage"] = stages
            # contract levels A-D + transfer + TEST 10 (§10/§11/§29/§39)
            # for validation-positive, non-clone candidates with recipes
            _lvl_pool = cands_df[
                (pd.to_numeric(cands_df["FWD_IS_expectancy"],
                               errors="coerce") > 0)].copy()
            if "mask_recipe" in cands_df:
                _lvl_pool = _lvl_pool[
                    _lvl_pool["mask_recipe"].astype(str) != "{}"]
            _lvl_pool = _lvl_pool.nlargest(
                min(25, len(_lvl_pool)), "FWD_IS_expectancy") \
                if len(_lvl_pool) else _lvl_pool
            _lvlA, _lvlB, _lvlC, _lvlD, _t10, _txe = {}, {}, {}, {}, {}, {}
            for _, _r in _lvl_pool.iterrows():
                try:
                    _lo = contract_levels_and_transfer(
                        _r.to_dict(), _r.get("mask_recipe"),
                        _r.get("symbol_id"), symbol_store, settings,
                        hreg, a.min_events)
                except Exception as _e:
                    _lo = {"level_A": [], "level_B": [],
                           "level_C": {"error": str(_e)}, "level_D": [],
                           "test10": {"pool_sum_match": "UNTESTABLE"},
                           "transfer_expectancy": float("nan"),
                           "agg_audit": []}
                _h = _r["hypothesis_id"]
                _lvlA[_h] = _lo["level_A"]
                _lvlB[_h] = _lo["level_B"]
                _lvlC[_h] = _lo["level_C"]
                _lvlD[_h] = _lo["level_D"]
                _t10[_h] = _lo["test10"]
                _txe[_h] = _lo["transfer_expectancy"]
                for _ln in _lo.get("agg_audit", [])[:3]:
                    print(f"AGG_AUDIT {_h}: {_ln}")
            cands_df["level_A_contracts"] = cands_df["hypothesis_id"].map(
                lambda h: str(_lvlA.get(h, [])))
            cands_df["level_B_expiry"] = cands_df["hypothesis_id"].map(
                lambda h: str(_lvlB.get(h, [])))
            cands_df["level_C_cross_expiry"] = cands_df["hypothesis_id"].map(
                lambda h: str(_lvlC.get(h, {})))
            cands_df["level_D_transfer"] = cands_df["hypothesis_id"].map(
                lambda h: str(_lvlD.get(h, [])))
            cands_df["transfer_expectancy"] = cands_df["hypothesis_id"].map(
                lambda h: _txe.get(h, float("nan")))
            cands_df["pool_sum_check"] = cands_df["hypothesis_id"].map(
                lambda h: str(_t10.get(h, {}).get("pool_sum_match",
                                                  "UNTESTABLE")))
            _t10bad = [h for h, t in _t10.items()
                       if t.get("pool_sum_match") == "FAIL"]
            if _t10bad:
                print(f"ENGINE_ERROR pool-sum mismatch: {_t10bad}")
                engine_error = f"POOL_SUM_MISMATCH:{_t10bad}"
                raise SystemExit("ENGINE_ERROR_POOL_SUM")
            # SYMBOL x EXIT table (§27)
            if "exit_hold" in cands_df and "symbol_id" in cands_df:
                print("SYMBOL x EXIT:")
                try:
                    print(cands_df.groupby("symbol_id")["exit_hold"].agg(
                        ["count", "median", "min", "max"]).to_markdown())
                except Exception:
                    pass
            # OOS-positive but MT-failed → registry routing (§22, never tune;
            # per-symbol frontiers already closed, recorded for the report)
            _mt_routed = []
            for _, r in cands_df[
                    (cands_df["OOS_stage"] == "OOS_THRESHOLD_PASS")].iterrows():
                hreg.mark(r["hypothesis_id"], "oos_rejected")
                _mt_routed.append(r["hypothesis_id"])
            for _, r in cands_df[
                    cands_df["paper_eligible"] == True].iterrows():  # noqa: E712
                hreg.mark(r["hypothesis_id"], "validated")
            # MULTIPLE_TEST_REJECTED status (§33): OOS-positive but BH-failed
            if "perm_p_adj" in cands_df:
                for _, r in cands_df[
                        (cands_df["OOS_trading_result"] == "OOS_TRADING_RULE_PASS")
                        & (cands_df["perm_p_adj"] >= 0.10)].iterrows():
                    try:
                        hreg.hypotheses[r["hypothesis_id"]]["registry_status"] = \
                            "MULTIPLE_TEST_REJECTED"
                    except Exception:
                        pass
        else:
            for _c in ("perm_p_adj", "OOS_trading_result", "paper_eligible",
                       "discovery_family"):
                cands_df[_c] = []
        filt_surv, filt_log = run_filters(cands_df)
        print("FILTER PIPELINE (F1..F13):")
        for f in filt_log:
            print(f"  {f['filter']}: in={f['input_count']} passed={f['passed_count']} "
                  f"rejected={f['rejected_count']} ({f['rejection_reason']})")
        # exit-propagation gate per symbol (§42/§49): independent plumbing
        # check on each symbol's own frame; any failure → ENGINE_ERROR
        from .backtest import pnl_diagnostic
        _prop_ok, _prop_fails = True, []
        for _sid, _ss in symbol_store.items():
            _f = _ss.get("feat")
            if _f is None or len(_f) == 0:
                continue
            _m = pd.Series(False, index=_f.index)
            if "e_expansion" in _f.columns:
                _m.loc[_f[_f["e_expansion"] == 1].head(200).index] = True
            if _m.sum() < 10:
                _m.iloc[:200] = True
            _prop = propagation_gate(_f, _m)
            _pnld = pnl_diagnostic(*_prop["ledgers"].values())
            prop_by_symbol[_sid] = {
                "EXIT_PARAMETER_PROPAGATION": _prop["EXIT_PARAMETER_PROPAGATION"],
                "pnl_status": _pnld["status"]}
            print(f"EXIT_PROPAGATION [{_sid}] = "
                  f"{_prop['EXIT_PARAMETER_PROPAGATION']}/{_pnld['status']}")
            if _pnld["status"] != "PASS":
                _prop_ok = False
                _prop_fails.append(_sid)
        print("EXIT_STRUCTURE_PROPAGATION = "
              f"{'PASS' if _prop_ok else 'FAIL'} (all symbols)")
        exit_ok = bool(_prop_ok)
        if not _prop_ok:
            engine_error = f"PNL_NAN:{','.join(_prop_fails)}"
            raise SystemExit("ENGINE_ERROR_PROPAGATION")
        tested = len(cands_df)
        surv_n = int(cands_df["paper_eligible"].sum()) if len(cands_df) else 0
        mt_surv = int(((cands_df["perm_p_adj"] < 0.10) &
                       (cands_df["OOS_trading_result"] == "OOS_TRADING_RULE_PASS")).sum()) \
            if len(cands_df) else 0
        print(f"OOS_CANDIDATES_TESTED={tested}\nOOS_TRADING_SURVIVED={surv_n} MT_SURVIVORS={mt_surv}")
        print(f"GLOBAL_TEST_COUNT={hreg.global_test_count} "
              f"UNIQUE_HYPOTHESES={hreg.n} DUPLICATES={hreg.duplicate_count} "
              f"CLONES={hreg.clone_count}")
        # FIX 3 surrogate transparency: full null distribution + empirical
        # percentile for top validation candidates, written to file
        import json as _js
        surr_out = []
        if len(cands_df):
            _top = cands_df.nlargest(min(20, len(cands_df)),
                                     "FWD_IS_expectancy")
            _rng = np.random.default_rng(42)
            for _, _r in _top.iterrows():
                _ss = symbol_store.get(_r.get("symbol_id"), {})
                _m = _ss.get("masks", {}).get(_r["hypothesis_id"])
                _cfg = _EXIT_CFG.get(_r["hypothesis_id"], {})
                if _m is None or not _cfg:
                    continue
                try:
                    _tc = _cfg.get("trail_cfg")
                    _led = backtest(_ss["feat"], _m.fillna(False),
                                    hold_bars=int(_cfg.get("hold", 5)),
                                    sl=float(_cfg.get("sl", 0.5)),
                                    tp=float(_cfg.get("tp", 1.0)),
                                    trail=None,
                                    trail_cfg=None if (
                                        not _tc or _tc.get("kind") == "none")
                                    else _tc,
                                    stop_type=_cfg.get("stop_type",
                                                       "FIXED_PERCENT"),
                                    target_type=_cfg.get("target_type",
                                                         "FIXED_PERCENT"),
                                    trail_type=_cfg.get("trail_type", "NONE"),
                                    exit_mode="premium", cid="SURR",
                                    verify=False)
                    _rv = pd.to_numeric(_led["ret"], errors="coerce").dropna().values
                    if len(_rv) < 10:
                        continue
                    _obs = float(np.mean(_rv) / (np.std(_rv) + 1e-9) * np.sqrt(len(_rv)))
                    _null = [float(np.mean(_p) / (np.std(_p) + 1e-9) * np.sqrt(len(_p)))
                             for _p in (_rng.permutation(_rv)
                                        for _ in range(int(settings.n_perm)))]
                    surr_out.append({
                        "hypothesis_id": _r["hypothesis_id"],
                        "symbol_id": _r.get("symbol_id", ""),
                        "observed_sharpe": round(_obs, 4),
                        "surrogate_mean": round(float(np.mean(_null)), 4),
                        "surrogate_sd": round(float(np.std(_null)), 4),
                        "empirical_percentile": round(
                            float((np.array(_null) < _obs).mean() * 100), 2),
                        "p_value": round(float((np.sum(np.abs(_null) >= abs(_obs)) + 1)
                                               / (int(settings.n_perm) + 1)), 4),
                        "n_perm": int(settings.n_perm),
                        "null_distribution": [round(float(x), 4) for x in _null]})
                except Exception:
                    continue
            with open(os.path.join(outdir, "surrogate_distributions.json"), "w") as _sf:
                _js.dump(surr_out, _sf, indent=1)
            print(f"SURROGATE_DISTRIBUTIONS written for {len(surr_out)} candidates "
                  f"(null + empirical percentile; FIX 3)")
        # execution/data limitation statuses aggregated across symbols
        # (§14/§15, FIX 8/9/10)
        _any_bidask = any(v.get("has_bidask", False)
                          for v in symbol_store.values())
        print(f"EXECUTION_STATUS={'AVAILABLE' if _any_bidask else 'UNAVAILABLE'} "
              f"PAPER_ELIGIBLE=FALSE")
        _und_vals = norm_global["underlying"].astype(str) \
            if "underlying" in norm_global.columns else pd.Series(["UNKNOWN"])
        _und = "AVAILABLE" if ((_und_vals.str.upper() != "UNKNOWN").any()) else "UNAVAILABLE"
        print(f"UNDERLYING_STATUS={_und} MONEYNESS_STATUS=UNAVAILABLE "
              f"(moneyness never inferred from strike labels)")
        _all_exp = sorted({e for v in symbol_store.values()
                           for e in (v.get("meta", {}).get("expiries") or [])})
        print(f"EXPIRY_GENERALIZATION={'AVAILABLE' if len(_all_exp) >= 2 else 'UNTESTABLE'}"
              f"{'' if len(_all_exp) >= 2 else ' (single expiry: no neutral score assigned)'}")
        print(f"OOS_FROZEN=true OOS_REOPTIMIZED=false")
        dataset_hash = hashlib.sha256(
            pd.util.hash_pandas_object(norm_global, index=True).values.tobytes()).hexdigest()[:16]
        seqs_df = cands_df[cands_df["discovery_family"] == "SEQUENCE"] if len(cands_df) else pd.DataFrame()
        states_df = cands_df[cands_df["discovery_family"] == "CHAIN_STATE"] if len(cands_df) else pd.DataFrame()
        counts = {"total_features_tested": FEATURE_COUNT["n"],
                  "total_relationships_tested": REL_COUNT["n"],
                  "total_sequences_tested": SEQ_COUNT["n"],
                  "total_states_tested": STATE_COUNT["n"],
                  "total_candidate_events": len(cands_df),
                  "raw_hypotheses": hreg.n,
                  "effective_hypotheses": hreg.n,
                  "equivalence_groups": len(hreg.equivalence_groups),
                  "global_test_count": hreg.global_test_count,
                  "OOS_exposure_count": int(cands_df["OOS_events"].sum()) if len(cands_df) else 0,
                  "total_cycles": n_round,
                  "total_discoveries": len(all_discoveries),
                  "clone_count": hreg.clone_count,
                  "cycle_statuses": [l.get("cycle_status") for l in ctrl.round_logs],
                  # §22 multiple-testing ledger (never weakened)
                  "RAW_TEST_COUNT": hreg.global_test_count,
                  "EFFECTIVE_TEST_COUNT": int(hreg.n - hreg.clone_count),
                  "BH_PASS": int(((cands_df["perm_p_adj"] < 0.10)).sum()) if len(cands_df) and "perm_p_adj" in cands_df else 0,
                  "HOLM_PASS": int(((cands_df["perm_p_holm"] < 0.10)).sum()) if len(cands_df) and "perm_p_holm" in cands_df else 0,
                  "BONF_PASS": int(((cands_df["perm_p_bonf"] < 0.10)).sum()) if len(cands_df) and "perm_p_bonf" in cands_df else 0,
                  "SURROGATE_PASS": int(((cands_df["perm_p"] < 0.10)).sum()) if len(cands_df) and "perm_p" in cands_df else 0,
                  "space_exhausted": bool(space_exhausted)}
        # candidate boards (§43)
        # candidate boards (§29/§43): entry/exit scored separately; no
        # overall winner from entry expectancy alone
        boards = {}
        if len(cands_df):
            num = cands_df.copy()
            boards["TOP_INFORMATIONAL"] = num.nlargest(20, "FWD_expectancy")["candidate"].tolist()
            boards["TOP_PREDICTIVE"] = num.nlargest(20, "FWD_IS_expectancy")["candidate"].tolist()
            boards["TOP_ENTRY"] = boards["TOP_PREDICTIVE"]
            boards["TOP_EXIT"] = num.nlargest(20, "DISCOVERED_expectancy")["candidate"].tolist() \
                if "DISCOVERED_expectancy" in num else []
            boards["TOP_ENTRY_EXIT"] = num.nlargest(20, "IS_expectancy")["candidate"].tolist()
            boards["TOP_ROBUST"] = num.nlargest(20, "robustness_score")["candidate"].tolist()
            boards["TOP_OOS"] = num.nlargest(20, "OOS_expectancy")["candidate"].tolist()
            boards["TOP_MULTIPLE_TEST"] = num.nsmallest(20, "perm_p_adj")["candidate"].tolist()
            boards["TOP_EXECUTABLE"] = []
            boards["PAPER_ELIGIBLE"] = num[num["paper_eligible"]]["candidate"].tolist()
            # legacy aliases kept for existing consumers
            boards["TOP_INFORMATION"] = boards["TOP_INFORMATIONAL"]
            boards["TOP_TRAIN"] = boards["TOP_PREDICTIVE"]
            boards["TOP_VALIDATION"] = boards["TOP_PREDICTIVE"]
            boards["TOP_OOS_INFORMATION"] = num.nlargest(20, "FWD_OOS_expectancy")["candidate"].tolist()
            boards["TOP_TRADING_RULE"] = boards["TOP_ENTRY_EXIT"]
            boards["TOP_MULTIPLE_TESTING"] = boards["TOP_MULTIPLE_TEST"]
            # §46 per-symbol / contract / path / hold boards + transfer
            if "symbol_id" in num:
                for _s, _g in num.groupby("symbol_id"):
                    boards[f"TOP_SYMBOL_{_s}"] = _g.nlargest(
                        20, "FWD_IS_expectancy")["candidate"].tolist()
            if "contract" in num:
                boards["TOP_CONTRACT"] = num.nlargest(
                    20, "contract_positive_fraction"
                    if "contract_positive_fraction" in num else "FWD_expectancy")[
                    "candidate"].tolist()
            if "return_path_class" in num:
                boards["TOP_RETURN_PATH"] = num[
                    num["return_path_class"] != "NOISE"].nlargest(
                    20, "FWD_IS_expectancy")["candidate"].tolist()
            if "exit_hold" in num:
                boards["TOP_HOLD"] = num.nlargest(20, "FWD_IS_expectancy")[
                    ["candidate", "exit_hold"]].to_dict(orient="records")
            boards["GLOBAL_TRANSFER"] = num[
                num.get("transfer_expectancy", pd.Series(
                    [float("nan")] * len(num),
                    index=num.index)) > 0]["candidate"].tolist() \
                if "transfer_expectancy" in num else []
        # ---- identity/leakage battery §39-§41 + FINAL AUDIT §48 ----
        # Any leak → ENGINE_ERROR (§49). No continuation on failure.
        from .identity import run_identity_tests
        _ident = {}
        for _sid, _ss in symbol_store.items():
            _f = _ss.get("feat")
            if _f is None or len(_f) == 0:
                continue
            try:
                _t = run_identity_tests(_f)
            except Exception as _e:
                _t = {"status": "FAIL", "reason": str(_e)}
            _ident[_sid] = _t
        _all_inst = sorted({i for v in symbol_store.values()
                            for i in (v.get("feat", pd.DataFrame()).get(
                                "instrument_id", pd.Series([], dtype=str)).astype(
                                str).unique().tolist() if v.get("feat") is not None else [])})
        _coll = sum(1 for v in symbol_store.values()
                    for _c in [v.get("feat")] if _c is not None
                    for _g, _e in _c.groupby("instrument_id")["expiry"]
                    .apply(lambda s: s.astype(str).nunique()).items() if _e > 1)
        _leak_sum = lambda k: sum(
            (t.get(k, 0) if isinstance(t.get(k), int) else 0)
            for t in _ident.values())
        print("===== IDENTITY AUDIT (§48) =====")
        print(f"SYMBOLS_DETECTED={len(symbol_store)} "
              f"SYMBOLS_INDEPENDENTLY_EXECUTED={len(symbol_store)}")
        print(f"EXPIRIES_DETECTED={_all_exp}")
        print(f"UNIQUE_INSTRUMENT_IDS={len(_all_inst)}")
        print(f"INSTRUMENT_ID_COLLISIONS={_coll}")
        print(f"CROSS_SYMBOL_LEAKS={_leak_sum('instrument_multi_symbol')}")
        print(f"CROSS_EXPIRY_LEAKS={_leak_sum('instrument_multi_expiry')}")
        print(f"CROSS_CONTRACT_LEAKS={_leak_sum('cluster_cross_instrument')}")
        print(f"CROSS_SYMBOL_ROLLING_LEAKS={_leak_sum('cross_symbol_rolling')}")
        print(f"CROSS_SYMBOL_FORWARD_LABEL_LEAKS={_leak_sum('forward_label_cross')}")
        print(f"TRADE_CROSS_INSTRUMENT={_LEDGER_AUDIT.get('trade_cross_instrument', 0)} "
              f"TRADE_CROSS_SYMBOL={_LEDGER_AUDIT.get('trade_cross_symbol', 0)} "
              f"TRADE_CROSS_EXPIRY={_LEDGER_AUDIT.get('trade_cross_expiry', 0)} "
              f"LEDGER_IDENTITY_FAIL={_LEDGER_AUDIT.get('ledger_identity_fail', 0)} "
              f"TRADES_CHECKED={_LEDGER_AUDIT.get('trades_checked', 0)}")
        _ident_fail = [s for s, t in _ident.items()
                       if t.get("status") == "FAIL"] or (
            ["ledger"] if any(_LEDGER_AUDIT.get(k, 0) for k in
                               ("trade_cross_instrument",
                                "trade_cross_symbol", "trade_cross_expiry",
                                "ledger_identity_fail")) else [])
        if _ident_fail or _coll:
            print(f"ENGINE_ERROR identity failure: symbols={_ident_fail} "
                  f"collisions={_coll}")
            engine_error = f"IDENTITY_FAIL:{_ident_fail}"
            raise SystemExit("ENGINE_ERROR_IDENTITY")
        # §27 exit audit headcounts
        print(f"EXIT_ENTRY_CANDIDATES={len(cands_df)}")
        # §33 OOS report per symbol
        if len(cands_df) and "symbol_id" in cands_df:
            print("SYMBOL x OOS:")
            for _s, _g in cands_df.groupby("symbol_id"):
                print(f"  {_s} OOS_TESTED={len(_g)} "
                      f"OOS_RAW_POSITIVE={int((_g['OOS_stage'] == 'OOS_RAW_POSITIVE').sum())} "
                      f"OOS_THRESHOLD_PASS={int((_g['OOS_stage'] == 'OOS_THRESHOLD_PASS').sum())} "
                      f"OOS_ROBUST_PASS={int((_g['OOS_stage'] == 'OOS_ROBUST_PASS').sum())} "
                      f"OOS_MULTIPLE_TEST_PASS={int((_g['OOS_stage'] == 'OOS_MULTIPLE_TEST_PASS').sum())} "
                      f"OOS_FINAL_SURVIVOR={int((_g['OOS_stage'] == 'OOS_FINAL_SURVIVOR').sum())}")
        meta_out = {"run_id": run_id, "dataset_path": a.path, "data_format": layout,
                    "symbols": sorted(symbol_store.keys()),
                    "symbol_health": dict(symbol_health),
                    "chain": sorted({c for v in symbol_store.values()
                                     for c in (v.get("chain") or [])}),
                    "identity_audit": {s: {k: v for k, v in t.items()
                                           if k != "status"}
                                       for s, t in _ident.items()},
                    "ledger_audit": dict(_LEDGER_AUDIT),
                    "dataset_hash": dataset_hash,
                    "settings": settings.to_dict(),
                    "configuration_hash": settings.configuration_hash(),
                    "feature_version": settings.feature_version,
                    "engine_version": settings.engine_version,
                    "random_seed": settings.random_seed,
                    "bar_frequency": bar_freq, "timeframe": settings.timeframe,
                    "execution_model": ("EXECUTABLE_PRICE_MODEL" if _any_bidask
                                        else "RESEARCH_PRICE_MODEL"),
                    "cost_mode": settings.cost_mode,
                    "chain_metadata": {
                        "symbols": {s: {k: (v if not isinstance(v, pd.DataFrame)
                                            else f"<frame {len(v)} rows>")
                                        for k, v in m.items()
                                        if k != "registry"}
                                    for s, m in symbol_metas.items()},
                        "n_symbols": len(symbol_metas),
                        "all_expiries": _all_exp},
                    "modules": {},
                    "modules_unavailable": {},
                    "per_symbol_modules": {
                        s: {k: v[0] for k, v in v2["mods"].items()}
                        for s, v2 in symbol_store.items() if "mods" in v2},
                    "filter_log": filt_log,
                    "filter_survivors": int(len(filt_surv)),
                    "formulas": FORMULAS,
                    "counts": counts,
                    "seed": settings.random_seed,
                    "feature_quality": {s: v.to_dict(orient="records")
                                          for s, v in fq_by_symbol.items()},
                    "boards": boards,
                    "search": {"rounds": n_round, "converged": converged,
                               "converged_all_symbols": converged,
                               "frontier_remaining": _all_front,
                               "stop_why": stop_why or "LOOP_END",
                               "round_logs": ctrl.round_logs,
                               "per_symbol": {
                                   s: {"converged": v.get("converged"),
                                       "stop_why": v.get("stop_why"),
                                       "frontier": v.get("frontier_size")}
                                   for s, v in symbol_store.items()}},
                    "splits": {s: {k: [str(d) for d in v]
                                   for k, v in (v2.get("splits", {}) or {}).items()}
                               for s, v2 in symbol_store.items()}}
        _rep_health = {"status": "DATA_VALID" if any(
            v in ("DATA_VALID", "DATA_PARTIAL")
            for v in symbol_health.values()) else "DATA_INVALID",
            "rows": int(len(norm_global)),
            "symbols": sorted(symbol_store.keys())}
        rep = write_report(outdir, meta_out, _rep_health, "", "", cands_df, ll, states_df, seqs_df,
                           wf, leak, True, counts)
        bundle = {
            "run_id": run_id, "dataset_hash": dataset_hash,
            "configuration_hash": settings.configuration_hash(), "settings": settings.to_dict(),
            "status_bar": {
                "DATA_READY": ("PASS" if any(
                    v == "DATA_VALID" or v == "DATA_PARTIAL"
                    for v in symbol_health.values()) else "FAIL"),
                "CHAIN_READY": "PASS",
                "SYMBOLS": sorted(symbol_store.keys()),
                "FEATURES_READY": "PASS", "DISCOVERY_READY": "PASS",
                "VALIDATION_READY": "PASS",
                "OOS_READY": "PASS",
                "ROBUSTNESS_READY": "PASS",
                "TRADING_RULE_DISCOVERY_READY": "PASS",
                "RETURN_PATH_READY": "PASS",
                "MULTIPLE_TESTING_READY": "PASS",
                "IDENTITY_READY": "PASS" if not _ident_fail else "FAIL",
                "EXECUTION_MODEL": ("EXECUTABLE_PRICE_MODEL" if _any_bidask
                                    else "RESEARCH_PRICE_MODEL"),
                "PAPER_ELIGIBLE": "FALSE",
            },
            "data_health": {"status": _rep_health["status"],
                              "symbols": _rep_health["symbols"]}, "chain_metadata": meta_out["chain_metadata"],
            "modules": meta_out["modules"], "modules_unavailable": meta_out["modules_unavailable"],
            "counts": counts, "filter_log": filt_log, "boards": boards,
            "candidates": cands_df.fillna("NA").to_dict(orient="records") if len(cands_df) else [],
            "leadlag": ll.fillna("NA").to_dict(orient="records") if len(ll) else [],
            "formulas": FORMULAS, "sharpe_defs": SHARPE_DEFS,
        }
        import json as _json
        with open(os.path.join(outdir, "tab_bundle.json"), "w") as f:
            _json.dump(bundle, f, indent=1, default=str)
        print(f"TAB_BUNDLE written: {outdir}/tab_bundle.json")
        print("===== OPTION NATIVE DISCOVERY AUDIT =====")
        for fam in sorted(cands_df["discovery_family"].unique().tolist()) if len(cands_df) else []:
            sub = cands_df[cands_df["discovery_family"] == fam]
            print(f"{fam}: candidates_tested={len(sub)} "
                  f"OOS_trading_pass={int((sub['OOS_trading_result'] == 'OOS_TRADING_RULE_PASS').sum())}")
        print("FINAL_REPORT_SECTIONS=RUN_SUMMARY,DATA,CHAIN,FEATURES,DISCOVERY,"
              "TRADING_RULE_DISCOVERY,RETURN_PATH,ROBUSTNESS,OOS,MULTIPLE_TESTING,"
              "EXECUTION,PAPER_GATE,SEARCH_CONVERGENCE")
        # §26 EXIT SEARCH AUDIT (mandatory; run incomplete without it)
        from .exits import EXIT_AUDIT as _EA
        _mat = pd.DataFrame(_EA["matrix"]) if _EA["matrix"] else pd.DataFrame()
        if len(_mat):
            _mat.to_csv(os.path.join(outdir, "exit_audit.csv"), index=False)
        print("===== EXIT SEARCH AUDIT =====")
        print(f"EXIT_HYPOTHESES_GENERATED={_EA['generated']}")
        print(f"EXIT_HYPOTHESES_EVALUATED={_EA['evaluated']}")
        print(f"EXIT_COMBINATIONS_GENERATED={_EA['generated']}")
        print(f"EXIT_COMBINATIONS_EVALUATED={_EA['evaluated']}")
        print(f"EXIT_COMBINATIONS_REJECTED={_EA['rejected']}")
        print(f"EXIT_COMBINATIONS_UNTESTABLE={_EA['untestable']}")
        print(f"EXIT_COMBINATIONS_EXCLUDED_INVALID={_EA['excluded_invalid']}")
        print(f"EXIT_FAMILIES_TESTED={sorted(_EA['families'])}")
        print(f"EXIT_PARAMETER_VALUES_TESTED=stops:{len(_EA['stop_values']) or 'grid'} "
              f"targets:{len(_EA['target_values']) or 'grid'} "
              f"trails:{len(_EA['trail_values']) or 'grid'}")
        print(f"HOLD_VALUES_TESTED={sorted(_EA['holds'])}")
        if len(_mat):
            _show = _mat[["stop", "target", "trail", "hold", "tested",
                          "trades", "train_exp", "val_exp",
                          "oos_exp"]].head(40)
            print(_show.to_markdown(index=False))
        _all_front_items = [it for v in symbol_store.values()
                              for it in (v.get("frontier", []) or [])]
        _unres_exit = [it for it in _all_front_items
                       if it.get("unresolved_code")
                       in ("ENTRY_PROMISING_EXIT_UNRESOLVED",
                           "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED")]
        print(f"EXIT_UNRESOLVED_REMAINING={len(_unres_exit)}")
        for _it in _unres_exit[:10]:
            print(f"  {_it['hypothesis_id']} {_it['family']} "
                  f"{_it.get('unresolved_code')}")
        # §35 EXIT DISCOVERY SUMMARY (explicit answers)
        _n_prom = int(((cands_df["FWD_IS_expectancy"] > 0)).sum()) \
            if len(cands_df) and "FWD_IS_expectancy" in cands_df else 0
        _n_full = int(((cands_df["exit_combos_evaluated"] > 0)).sum()) \
            if len(cands_df) and "exit_combos_evaluated" in cands_df else 0
        print("===== EXIT DISCOVERY SUMMARY =====")
        print(f"stop_types_tested={sorted({m['stop'] for m in _EA['matrix']})}")
        print(f"target_types_tested={sorted({m['target'] for m in _EA['matrix']})}")
        print(f"trail_types_tested={sorted({m['trail'] for m in _EA['matrix']})}")
        print(f"hold_values_tested={sorted(_EA['holds'])}")
        print(f"complete_exit_combinations_tested={len(_EA['matrix'])}")
        print(f"candidate_specific_exits_tested={_n_full}")
        print(f"promising_entries={_n_prom} "
              f"full_exit_search_pct="
              f"{round(100.0 * _n_full / max(1, _n_prom), 1)}%")
        print(f"entries_remaining_EXIT_UNRESOLVED={len(_unres_exit)}")
        print(f"exit_combinations_unexplored_capped="
              f"{sum(1 for m in _EA['matrix'] if m.get('val_exp') == 'NA')}")
        print(f"SEARCH_CONVERGENCE converged={converged} frontier={_all_front} "
              f"rounds={n_round} stop_why={stop_why or 'LOOP_END'} "
              f"per_symbol={ {s: v.get('stop_why') for s, v in symbol_store.items()} }")
        final_state = final_status(surv_n, converged, _all_front,
                                   budget_hit, data_ok, "", "",
                                   search_completed=search_completed,
                                   space_exhausted=space_exhausted)
        print(f"FINAL_STATUS={final_state}")
        # §32 final report strata (appended after FINAL_STATUS is known)
        try:
            _by_cat = cands_df["discovery_category"].value_counts().to_dict() \
                if len(cands_df) and "discovery_category" in cands_df else {}
            _unres = [it for it in _all_front_items if it["status"] == "QUEUED"]
            with open(rep, "a") as _rf:
                _rf.write("\n## 17. INFORMATION DISCOVERIES\n")
                _rf.write(str(_by_cat.get("INFORMATION_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 18. PREDICTIVE DISCOVERIES\n")
                _rf.write(str(_by_cat.get("PREDICTIVE_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 19. TRADING-RULE DISCOVERIES\n")
                _rf.write(str(_by_cat.get("TRADING_RULE_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 20. ROBUST DISCOVERIES\n")
                _rf.write(str(_by_cat.get("ROBUST_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 21. OOS DISCOVERIES\n")
                _rf.write(str(_by_cat.get("OOS_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 22. VALIDATED EDGES\n")
                _rf.write(str(_by_cat.get("VALIDATED_EDGE", 0)) + "\n")
                _rf.write("\n## 23. FAILED HYPOTHESES\n")
                _rf.write(str(_by_cat.get("NO_DISCOVERY", 0)) + "\n")
                _rf.write("\n## 24. UNRESOLVED FRONTIER\n")
                _rf.write(f"{len(_unres)} items\n")
                for _it in _unres[:20]:
                    _rf.write(f"- {_it['hypothesis_id']} {_it['family']} "
                              f"{_it.get('unresolved_code', '')} "
                              f"next={_it.get('next_action', '')}\n")
                _rf.write("\n## 25. DATA LIMITATIONS\n")
                _rf.write(f"UNDERLYING_STATUS={_und} MONEYNESS_STATUS=UNAVAILABLE "
                          f"EXPIRY_GENERALIZATION="
                          f"{'AVAILABLE' if len(_all_exp) >= 2 else 'UNTESTABLE'}\n")
                _rf.write("\n## 26. EXECUTION LIMITATIONS\n")
                _rf.write(f"EXECUTION_STATUS={'AVAILABLE' if _any_bidask else 'UNAVAILABLE'} "
                          f"symbols={sorted(symbol_store.keys())}\n")
                _rf.write("\n## 27. GLOBAL TEST COUNT\n")
                _rf.write(f"{hreg.global_test_count} "
                          f"(unique={hreg.n} dup={hreg.duplicate_count} "
                          f"clones={hreg.clone_count})\n")
                _rf.write("\n## 28. TOTAL SEARCH CYCLES\n")
                _rf.write(f"{n_round} "
                          f"statuses={[l.get('cycle_status') for l in ctrl.round_logs]}\n")
                _rf.write("\n## 29. FINAL STATUS\n")
                _rf.write(f"{final_state}\n")
        except Exception as _e:
            print(f"REPORT_APPEND_SKIPPED: {_e}")
        if data_ok and not engine_error and not blocked_reason and surv_n == 0:
            print("NO_VALIDATED_EDGE (gates retained; no weakening)")
    except SystemExit as e:
        code = str(e)
        if "DATA_INVALID" in code:
            final_state = final_status(0, False, 0, False, False)
        elif blocked_reason or "BLOCKED" in code:
            final_state = final_status(0, False, 0, False, True, "", blocked_reason or code)
        elif "ENGINE_ERROR" in code:
            final_state = "ENGINE_ERROR"
        elif "PNL_NAN" in code:
            final_state = "ENGINE_ERROR"
        print(f"FINAL_STATUS={final_state}")
        raise
    except RecursionError as e:
        print(f"ENGINE_ERROR recursion: {e}")
        print(f"FINAL_STATUS={final_status(0, False, 0, False, True, 'recursion', '')}")
        raise SystemExit("ENGINE_ERROR")
    except Exception as e:
        print(f"ENGINE_ERROR {type(e).__name__}: {e}")
        traceback.print_exc()
        print(f"FINAL_STATUS={final_status(0, False, 0, False, True, str(e), '')}")
        raise SystemExit("ENGINE_ERROR")


if __name__ == "__main__":
    main()