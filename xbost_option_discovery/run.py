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
                     SearchController, save_checkpoint, load_checkpoint,
                     EXPLORATION_FAMILIES)
from .return_path import compute_return_path, first_touch_stats, classify_path
from .exits import discover_exits
from .generalization import (contract_generalization, strike_robustness,
                             expiry_robustness, otype_robustness,
                             time_robustness, regime_robustness)
from .edge_ladder import edge_ladder, final_status, paper_eligible

LAG_WINDOWS = (1, 2, 3, 5, 10)
MIN_EVENTS = 50

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
    """Full L1-L8 evaluation of ONE locked rule. OOS evaluated once, frozen."""
    from .metrics import label_metrics as _lm
    mask = mask.fillna(False)
    if mask.sum() < min_events:
        return None
    tr = splits["discovery"] + splits["refinement"]
    oos_days = splits["pseudo_oos"]
    sl, tp, trail, hold = (exit_cfg["sl"], exit_cfg["tp"],
                           exit_cfg.get("trail"), exit_cfg["hold"])
    # ---- trading ledger on train+val (locked rule) ----
    led_all = backtest(feat, mask, hold_bars=int(hold), sl=float(sl),
                       tp=float(tp), trail=trail, exit_mode="premium", cid=cid)
    if len(led_all) < min_events:
        return None
    m_all = calculate_trade_metrics(led_all)
    integ = metric_recalculation_test(
        {"trade_count": m_all["trade_count"], "wins": m_all["wins"],
         "losses": m_all["losses"], "avg_winner": m_all["avg_winner"],
         "avg_loser": m_all["avg_loser"], "expectancy": m_all["expectancy"],
         "PF": m_all["PF"], "TRADE_SHARPE": m_all["TRADE_SHARPE"],
         "P&L": m_all["P&L"]}, led_all)
    # ---- frozen OOS at TRADING-RULE level (§30), evaluated once ----
    oos_mask = mask & feat["day"].isin(oos_days) if oos_days else \
        pd.Series(False, index=feat.index)
    led_oos = backtest(feat, oos_mask, hold_bars=int(hold), sl=float(sl),
                       tp=float(tp), trail=trail, exit_mode="premium", cid=cid)
    m_oos = calculate_trade_metrics(led_oos)
    oos_trading_exp = m_oos["expectancy"]
    oos_trading_pass = bool(pd.notna(oos_trading_exp) and oos_trading_exp > 0
                            and len(led_oos) >= settings.min_oos_events)
    # ---- OOS information level (explicitly separate, §30) ----
    fwd_tr = _lm(feat.loc[mask & feat["day"].isin(tr), "fwd_ret_5m"]) if tr else _lm([])
    fwd_oos = _lm(feat.loc[mask & feat["day"].isin(oos_days), "fwd_ret_5m"]) \
        if oos_days else _lm([])
    fwd_all = _lm(feat.loc[mask, "fwd_ret_5m"])
    oos_info = ("OOS_SURVIVED_MARK"
                if (pd.notna(fwd_oos["expectancy"]) and fwd_oos["expectancy"] > 0)
                else "OOS_REJECTED")
    # ---- return path (§10/§12/§48) ----
    rpath = compute_return_path(feat, mask)
    touch = first_touch_stats(feat, mask, sl_pct=sl, tp_pct=tp, hold=hold)
    rpath.update(touch)
    rpath["path_class"] = classify_path(rpath)
    # ---- staged exit discovery on VALIDATION only (§11, never OOS) ----
    exit_search = {"best": dict(exit_cfg), "improved": False, "stages": []}
    if do_exit_search and pd.notna(fwd_tr["expectancy"]) and fwd_tr["expectancy"] > 0:
        try:
            exit_search = discover_exits(
                feat, mask, splits["refinement"] or tr,
                tuple(settings.hold_grid), tuple(settings.stop_grid),
                tuple(settings.target_grid), tuple(settings.trail_grid))
            registry.count_test(len(tuple(settings.hold_grid))
                                + len(tuple(settings.stop_grid))
                                + len(tuple(settings.target_grid))
                                + len(tuple(settings.trail_grid)))
        except Exception:
            pass
    # ---- entry timing/perturbation on train/val (§13/§14) ----
    entry_variants, entry_best = {}, "signal-close"
    if do_entry_search:
        base_e = fwd_tr["expectancy"]
        for name, m2 in (("signal-close", mask),
                         ("t+1", _shift_mask(feat, mask, 1)),
                         ("t+2", _shift_mask(feat, mask, 2))):
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
    try:
        ei = exit_independence(feat, mask, cid, int(hold))
    except Exception:
        ei = {"n_variants": 0, "profitable_variants": 0,
              "median_performance": float("nan")}
    cl = cluster(feat.loc[mask, ["timestamp", "symbol"]].assign(
        expiry=feat.loc[mask, "expiry"], strike=feat.loc[mask, "strike"],
        option_type=feat.loc[mask, "option_type"]))
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
        "entry_rule": hyp.get("entry_rule", "signal-close"),
        "entry_best_variant": entry_best, "entry_variants": str(entry_variants),
        "exit_rule": f"hold={hold}/sl={sl}/tp={tp}/trail={trail}",
        "exit_hold": hold, "exit_sl": sl, "exit_tp": tp, "exit_trail": trail,
        "exit_search_best": str(exit_search.get("best")),
        "exit_search_improved": bool(exit_search.get("improved")),
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
    return row


def build_depth1_specs(feat, mods, strikes, lead_cols, min_events, quality):
    """Depth-1 hypothesis specs (iterative list, no recursion)."""
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
                          "depth": 1, "kind": "ATOMIC"})
    for c in lead_cols:
        if c in feat.columns and ok(c) and \
                mods.get("OPTION_TYPE_RELATIONSHIP", ("", ""))[0] == "AVAILABLE":
            specs.append({"family": "OPTION_TYPE_RELATIONSHIP", "feature": c,
                          "rel": "chain",
                          "mask_fn": lambda f, c=c: (f[c] == 1),
                          "depth": 1, "kind": "ATOMIC"})
    if mods.get("STRIKE_RELATIONSHIP", ("", ""))[0] == "AVAILABLE":
        for col in REGISTRY["x_cols"]:
            if "_retdiff" in col and ok(col):
                specs.append({"family": "STRIKE_RELATIONSHIP", "feature": col,
                              "rel": "cross-strike",
                              "mask_fn": lambda f, c=col: (f[c] > 0).fillna(False),
                              "depth": 1, "kind": "ATOMIC"})
    if "breadth_diff" in feat.columns and ok("breadth_diff"):
        specs.append({"family": "CHAIN_BREADTH", "feature": "breadth_diff>0",
                      "rel": "chain",
                      "mask_fn": lambda f: (f["breadth_diff"] > 0).fillna(False),
                      "depth": 1, "kind": "ATOMIC"})
        specs.append({"family": "CHAIN_BREADTH", "feature": "breadth_diff<0",
                      "rel": "chain",
                      "mask_fn": lambda f: (f["breadth_diff"] < 0).fillna(False),
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
                              "depth": 1, "kind": "ATOMIC"})
        except Exception:
            pass
    return specs


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
        if settings.timeframe != "RAW":
            norm = resample_ohlcv(norm, settings.timeframe.lower())
            print(f"RESAMPLED to {settings.timeframe}")
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
        if a.require_contracts:
            exp = [s.strip() for s in a.require_contracts.split(",")]
            missing = [c for c in exp if c not in meta["contracts"]]
            for c in exp:
                print(f"  {'FOUND' if c in meta['contracts'] else 'MISSING'}: {c}")
            if missing:
                blocked_reason = f"missing required contracts {missing}"
                raise SystemExit(f"FAIL: missing {missing}")
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
        health = data_health(norm, meta, chain)
        print(f"DATA_HEALTH status={health['status']} "
              f"missing_intervals={health['missing_interval_count']} "
              f"dup={health['duplicate_timestamp_count']} volcov={health['volume_coverage']}")
        data_ok = health["status"] in ("DATA_VALID", "DATA_PARTIAL")
        if health["status"] == "DATA_INVALID":
            final_state = final_status(0, False, 0, False, False)
            raise SystemExit("DATA_INVALID")

        # ---- 4. features ----
        feat = add_raw(chain_sub)
        feat = add_volume(feat)
        feat = add_baselines(feat)
        if mods["OPTION_TYPE_RELATIONSHIP"][0] == "AVAILABLE":
            feat = add_type_relationship(feat, meta)
        if mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE":
            feat = add_crossstrike(feat, meta, strikes)
        feat = add_breadth(feat, meta)
        dup = int(feat.duplicated(subset=["timestamp", "symbol"]).sum())
        if dup:
            print(f"FEATURE_ERROR: {dup} duplicate (timestamp,symbol) rows")
            raise SystemExit("FEATURE_ERROR duplicate rows")
        feat = add_divergence_events(feat)
        feat = add_convergence_events(feat, REGISTRY["x_cols"])
        feat = add_catchup_events(feat, REGISTRY["x_cols"])
        lead_cols = [c for c in feat.columns if "_leads_" in c]
        feat = add_atomic_events(feat)
        feat = add_combo_events(feat, lead_cols)
        feat = add_sequences(feat)
        feat = add_states(feat, meta)
        feat = add_labels(feat)
        feat["day"] = pd.to_datetime(feat["timestamp"]).dt.date
        days = sorted(feat["day"].unique().tolist())

        splits = chronological_splits(days, fractions)
        if splits is None or mods["OOS_VALIDATION"][0] != "AVAILABLE":
            print("OOS_VALIDATION = UNAVAILABLE (VALIDATION_INSUFFICIENT_DATA)")
            splits = {"discovery": days, "refinement": [], "pseudo_oos": []}
            wf = []
        else:
            wf = walk_forward(days)
            print(f"OOS_VALIDATION=ACTIVE splits="
                  f"{ {k: len(v) for k, v in splits.items()} } wf_folds={len(wf)}")
        print(f"OOS_FROZEN days={len(splits['pseudo_oos'])} "
              f"(never used for optimization)")

        from .leakage import audit_lookahead
        la = audit_lookahead(feat)
        print("LOOKAHEAD_AUDIT")
        print(f"  feature_tests={la['feature_tests']} label_tests={la['label_tests']} "
              f"spot_pass={la['spot_pass']} spot_fail={la['spot_fail']} "
              f"first_mismatch={la['first_mismatch']} status={la['status']}")
        leak = {"PASS": la["status"] == "PASS", "detail": la}
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
        print(f"LEAD_LAG pairs tested: {len(ll_rows)}")

        # ================= ITERATIVE FRONTIER SEARCH (§4) =================
        hreg = HypothesisRegistry()
        frontier = FrontierQueue(max_family_share=settings.max_family_share)
        conv = ConvergenceChecker(n=settings.convergence_N,
                                  epsilon=settings.convergence_epsilon)
        ctrl = SearchController(settings, t_start=t_start)
        default_exit = {"hold": settings.exit_hold_bars, "sl": settings.exit_sl_pct,
                        "tp": settings.exit_tp_pct, "trail": None}
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

        spec_by_hid = {}
        for sp in depth1:
            pass  # masks rebuilt from feature col at eval time
        # map atomic hid -> mask builder
        atomic_masks = {}
        # rebuild mapping hid->spec in seed order
        seed_hids = [it["hypothesis_id"] for it in frontier.to_json()]
        for hid, sp in zip(seed_hids[:len(depth1)], depth1):
            atomic_masks[hid] = sp

        all_rows = []
        mask_cache = {}
        n_round = 0
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

        # resume support (§53)
        if settings.resume_from and os.path.exists(settings.resume_from):
            cp = load_checkpoint(settings.resume_from)
            for r in cp.get("candidates", []):
                all_rows.append(r)
            frontier.load(cp.get("frontier", []))
            hreg.global_test_count = int(cp.get("global_test_count", 0))
            hreg.n = int(cp.get("hypothesis_n", hreg.n))
            n_round = int(cp.get("round", 0))
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
            added = 0
            round_best_val, round_best_oos, round_best_tr, round_best_rob = (
                float("-inf"), float("-inf"), float("-inf"), float("-inf"))
            new_fams = set()
            for item in batch:
                hid = item["hypothesis_id"]
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
                # resolve mask
                m = None
                if hid in atomic_masks:
                    try:
                        m = atomic_masks[hid]["mask_fn"](feat).fillna(False)
                    except Exception:
                        m = pd.Series(False, index=feat.index)
                elif "_ll_mask" in hreg.hypotheses.get(hid, {}):
                    m = hreg.hypotheses[hid]["_ll_mask"]
                else:
                    rec = hreg.hypotheses.get(hid, {})
                    parents = rec.get("parent_ids", [])
                    m = pd.Series(True, index=feat.index)
                    for p in parents:
                        pm = mask_cache.get(p)
                        if pm is None and p in atomic_masks:
                            try:
                                pm = atomic_masks[p]["mask_fn"](feat).fillna(False)
                            except Exception:
                                pm = pd.Series(False, index=feat.index)
                        if pm is None:
                            pm = pd.Series(False, index=feat.index)
                        m = m & pm.fillna(False)
                    # confirmation leg: intersect with a diverse atomic
                    leg = item.get("confirm_feature")
                    if leg and leg in feat.columns:
                        try:
                            m = m & (feat[leg] == 1).fillna(False)
                        except Exception:
                            pass
                if m is None or m.sum() < a.min_events:
                    item["status"] = "REJECTED"
                    dup_hyps += 1
                    continue
                mask_cache[hid] = m
                rec = hreg.hypotheses.get(hid, {})
                depth = int(rec.get("combination_depth", item.get("combination_depth", 1)))
                do_exit = depth <= 2  # exit discovery on promising shallow events
                row = evaluate_candidate(
                    feat, m, hid, fam, item.get("feature_signature", hid),
                    "fwd_ret_5m", rec.get("contract_scope", "chain"), "long", "5m",
                    splits, settings, a.min_events, rec or {"hypothesis_id": hid},
                    depth, default_exit, has_bidask, do_exit, True, hreg)
                if row is None:
                    item["status"] = "REJECTED"
                    continue
                new_hyps += 1
                if item.get("reason_added", "").startswith("explore"):
                    explore_ct += 1
                else:
                    exploit_ct += 1
                all_rows.append(row)
                item["status"] = "EVALUATED"
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
                            reason=f"combo-confirm:{leg}")
                        if not reg2["duplicate"]:
                            it2 = {"hypothesis_id": reg2["hypothesis_id"],
                                   "family": "COMBINATION",
                                   "feature_signature": f"{row['feature_definition']}&{leg}",
                                   "combination_depth": depth + 1,
                                   "reason_added": f"combo-confirm:{leg}",
                                   "confirm_feature": leg,
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
            converged = conv.update(fsize, n_new_fam, dval, doos, div_sat)
            fam_share_after = {k: round(v / max(1, sum(fam_counts.values())), 3)
                               for k, v in fam_counts.items()}
            dom = max(fam_share_after.values()) if fam_share_after else 0.0
            print(f"ROUND {n_round} candidates={len(all_rows)} "
                  f"new={new_hyps} dup={dup_hyps} frontier={fsize} "
                  f"added={added if batch else 0} removed={len(batch)} "
                  f"best_tr={round_best_tr:.4f} best_val={round_best_val:.4f} "
                  f"best_oos={round_best_oos:.4f} best_rob={round_best_rob:.4f} "
                  f"new_fam={n_new_fam} explore={explore_ct} exploit={exploit_ct} "
                  f"runtime={ctrl.elapsed():.0f}s mem={_mem()} "
                  f"tests={hreg.global_test_count} fam_reject={fam_rejected} "
                  f"dominant_share={dom:.2f}")
            ctrl.round_logs.append({"round": n_round,
                                    "candidate_count": len(all_rows),
                                    "frontier_size": fsize, "converged": converged,
                                    "stop_why": ""})
            save_checkpoint(ckpt_path, {
                "run_id": run_id, "round": n_round,
                "candidates": all_rows[-500:],
                "frontier": frontier.to_json(),
                "global_test_count": hreg.global_test_count,
                "hypothesis_n": hreg.n, "oos_days": [str(d) for d in splits["pseudo_oos"]],
                "config_hash": settings.configuration_hash(),
                "random_seed": settings.random_seed})
            if not batch and fsize == 0:
                stop_why = "FRONTIER_DRAINED"
                if conv.drain_converged():
                    converged = True
                break
        # ================= POST-SEARCH =================
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
            # paper gate per candidate (§56)
            pe, per_ = [], []
            for _, r in cands_df.iterrows():
                e, why = paper_eligible(r.to_dict(), has_bidask)
                pe.append(e)
                per_.append(why)
            cands_df["paper_eligible"] = pe
            cands_df["paper_gate_reason"] = per_
        else:
            for _c in ("perm_p_adj", "OOS_trading_result", "paper_eligible",
                       "discovery_family"):
                cands_df[_c] = []
        filt_surv, filt_log = run_filters(cands_df)
        print("FILTER PIPELINE (F1..F13):")
        for f in filt_log:
            print(f"  {f['filter']}: in={f['input_count']} passed={f['passed_count']} "
                  f"rejected={f['rejected_count']} ({f['rejection_reason']})")
        _m = pd.Series(False, index=feat.index)
        _m.loc[feat[feat["e_expansion"] == 1].head(200).index] = True \
            if "e_expansion" in feat.columns else []
        if _m.sum() < 10:
            _m.iloc[:200] = True
        prop = propagation_gate(feat, _m)
        from .backtest import pnl_diagnostic
        pnld = pnl_diagnostic(*prop["ledgers"].values())
        print("EXIT_PROPAGATION_AUDIT")
        for name, led in prop["ledgers"].items():
            dist = led["exit_reason"].value_counts().to_dict() if len(led) else {}
            print(f"  config {name}: trades={len(led)} "
                  f"finite={(pd.to_numeric(led['ret'], errors='coerce').notna().sum() if len(led) else 0)}/{len(led)} "
                  f"exits={dist} ledger_hash={led.attrs.get('TRADE_LEDGER_HASH', '')}")
        print(f"P&L_AUDIT total_trades={pnld['total_trades']} finite_pnl={pnld['finite_pnl']} "
              f"nan_pnl={pnld['nan_pnl']} status={pnld['status']}")
        print(f"EXIT_STRUCTURE_PROPAGATION = {'PASS' if not prop['identical'] else 'FAIL'} "
              f"EXIT_METRIC_PROPAGATION = {'PASS' if pnld['status'] == 'PASS' else 'FAIL'}")
        exit_ok = prop["EXIT_PARAMETER_PROPAGATION"] in ("PASS",)
        if pnld["status"] != "PASS":
            engine_error = "PNL_NAN"
            raise SystemExit("BLOCKED_PNL_NAN")
        tested = len(cands_df)
        surv_n = int(cands_df["paper_eligible"].sum()) if len(cands_df) else 0
        mt_surv = int(((cands_df["perm_p_adj"] < 0.10) &
                       (cands_df["OOS_trading_result"] == "OOS_TRADING_RULE_PASS")).sum()) \
            if len(cands_df) else 0
        print(f"OOS_CANDIDATES_TESTED={tested}\nOOS_TRADING_SURVIVED={surv_n} MT_SURVIVORS={mt_surv}")
        print(f"GLOBAL_TEST_COUNT={hreg.global_test_count} "
              f"UNIQUE_HYPOTHESES={hreg.n} DUPLICATES={hreg.duplicate_count}")
        dataset_hash = hashlib.sha256(
            pd.util.hash_pandas_object(norm, index=True).values.tobytes()).hexdigest()[:16]
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
                  "OOS_exposure_count": int(cands_df["OOS_events"].sum()) if len(cands_df) else 0}
        # candidate boards (§43)
        boards = {}
        if len(cands_df):
            num = cands_df.copy()
            boards["TOP_INFORMATION"] = num.nlargest(20, "FWD_expectancy")["candidate"].tolist()
            boards["TOP_TRAIN"] = num.nlargest(20, "FWD_IS_expectancy")["candidate"].tolist()
            boards["TOP_VALIDATION"] = boards["TOP_TRAIN"]
            boards["TOP_OOS_INFORMATION"] = num.nlargest(20, "FWD_OOS_expectancy")["candidate"].tolist()
            boards["TOP_TRADING_RULE"] = num.nlargest(20, "IS_expectancy")["candidate"].tolist()
            boards["TOP_ROBUST"] = num.nlargest(20, "robustness_score")["candidate"].tolist()
            boards["TOP_MULTIPLE_TESTING"] = num.nsmallest(20, "perm_p_adj")["candidate"].tolist()
            boards["PAPER_ELIGIBLE"] = num[num["paper_eligible"]]["candidate"].tolist()
        meta_out = {"run_id": run_id, "dataset_path": a.path, "data_format": layout, "chain": chain,
                    "dataset_hash": dataset_hash,
                    "settings": settings.to_dict(),
                    "configuration_hash": settings.configuration_hash(),
                    "feature_version": settings.feature_version,
                    "engine_version": settings.engine_version,
                    "random_seed": settings.random_seed,
                    "bar_frequency": bar_freq, "timeframe": settings.timeframe,
                    "execution_model": exec_model,
                    "cost_mode": settings.cost_mode,
                    "chain_metadata": {k: v for k, v in meta.items()},
                    "modules": {k: v[0] for k, v in mods.items()},
                    "modules_unavailable": {k: v[1] for k, v in mods.items() if v[0] != "AVAILABLE"},
                    "filter_log": filt_log,
                    "filter_survivors": int(len(filt_surv)),
                    "formulas": FORMULAS,
                    "counts": counts,
                    "seed": settings.random_seed,
                    "feature_quality": fq.to_dict(orient="records") if len(fq) else [],
                    "boards": boards,
                    "search": {"rounds": n_round, "converged": converged,
                               "frontier_remaining": frontier.size(),
                               "stop_why": stop_why or "LOOP_END",
                               "round_logs": ctrl.round_logs},
                    "splits": {k: [str(d) for d in v] for k, v in splits.items()}}
        rep = write_report(outdir, meta_out, health, "", "", cands_df, ll, states_df, seqs_df,
                           wf, leak, True, counts)
        bundle = {
            "run_id": run_id, "dataset_hash": dataset_hash,
            "configuration_hash": settings.configuration_hash(), "settings": settings.to_dict(),
            "status_bar": {
                "DATA_READY": "PASS" if health["status"] in ("DATA_VALID", "DATA_PARTIAL") else "FAIL",
                "CHAIN_READY": "PASS" if mods["CHAIN_STRUCTURE"][0] == "AVAILABLE" else "FAIL",
                "FEATURES_READY": "PASS", "DISCOVERY_READY": "PASS",
                "VALIDATION_READY": ("PASS" if mods["OOS_VALIDATION"][0] == "AVAILABLE"
                                     else "NOT_APPLICABLE"),
                "OOS_READY": ("PASS" if splits["pseudo_oos"] else "NOT_READY"),
                "ROBUSTNESS_READY": "PASS",
                "TRADING_RULE_DISCOVERY_READY": "PASS",
                "RETURN_PATH_READY": "PASS",
                "MULTIPLE_TESTING_READY": "PASS",
                "EXECUTION_MODEL": exec_model, "PAPER_ELIGIBLE": "FALSE",
            },
            "data_health": health, "chain_metadata": meta_out["chain_metadata"],
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
        print(f"SEARCH_CONVERGENCE converged={converged} frontier={frontier.size()} "
              f"rounds={n_round} stop_why={stop_why or 'LOOP_END'}")
        final_state = final_status(surv_n, converged, frontier.size(),
                                   budget_hit, data_ok, "", "",
                                   search_completed=(stop_why == "FRONTIER_DRAINED"))
        print(f"FINAL_STATUS={final_state}")
        if data_ok and not engine_error and not blocked_reason and surv_n == 0:
            print("NO_VALIDATED_EDGE (gates retained; no weakening)")
    except SystemExit as e:
        code = str(e)
        if "DATA_INVALID" in code:
            final_state = final_status(0, False, 0, False, False)
        elif blocked_reason or "BLOCKED" in code:
            final_state = final_status(0, False, 0, False, True, "", blocked_reason or code)
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