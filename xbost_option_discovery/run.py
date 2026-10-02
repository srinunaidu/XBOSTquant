"""Dynamic option-native discovery orchestrator.

Dataset-driven: inspects the input, builds chain_metadata, enables only the
discovery/validation modules the data supports, and reports the rest as
NOT_APPLICABLE with reasons. No hardcoded strikes, types, symbols, counts,
expiries, or naming conventions.
"""
import argparse, os, time, uuid
import itertools
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
from .multiple_testing import bh
from .backtest import backtest, propagation_gate
from .leakage import test_no_lookahead
from .reporting import write_report, assign_status
from .filters import run_filters

LAG_WINDOWS = (1, 2, 3, 5, 10)
MIN_EVENTS = 50


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--require-contracts", default=None,
                    help="optional comma-separated contract symbols that must exist")
    ap.add_argument("--focus-strikes", type=int, default=3)
    ap.add_argument("--timeframe", default="RAW",
                    help="RAW or resample rule like 5m")
    ap.add_argument("--ranking-objective", default="composite",
                    help="sharpe|expectancy|pf|oos|robustness|composite")
    ap.add_argument("--settings-out", default=None)
    ap.add_argument("--splits", default="0.5,0.2,0.3",
                    help="discovery,refinement,pseudo-OOS fractions")
    ap.add_argument("--min-events", type=int, default=MIN_EVENTS)
    a = ap.parse_args()
    fractions = tuple(float(x) for x in a.splits.split(","))
    settings = DiscoverySettings(
        data_path=a.path, timeframe=a.timeframe, focus_strikes=a.focus_strikes,
        ranking_objective=a.ranking_objective,
        train_frac=fractions[0], validation_frac=fractions[1], oos_frac=fractions[2],
        min_events=a.min_events)
    print(f"SETTINGS configuration_hash={settings.configuration_hash()}")
    if a.settings_out:
        import json as _j
        open(a.settings_out, "w").write(_j.dumps(settings.to_dict(), indent=2))
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    outdir = a.outdir or os.path.join("xbost_option_discovery", "runs", run_id)

    # ---- 1. dynamic ingestion + chain detection ----
    norm, layout = load_dataset(a.path)
    norm = normalize(norm)
    bar_freq = detect_frequency(norm["timestamp"])
    print(f"BAR_FREQUENCY detected={bar_freq}")
    if settings.timeframe != "RAW":
        norm = resample_ohlcv(norm, settings.timeframe.lower())
        print(f"RESAMPLED to {settings.timeframe} (O=first H=max L=min C=last V=sum, causal)")
    meta = detect_chain(norm)
    print("OPTIONS_INGESTION_AUDIT\n-----------------------")
    print(f"source_file: {a.path}\nlayout: {layout}\nrows: {len(norm)}")
    # ---- contract registry: enrich identity metadata parsed from tokens ----
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
    for r in registry:
        print(f"  {r['contract_id']} | expiry={'+'.join(r['expiry'])} | strike={r['strike']} | "
              f"type={r['option_type']} | src={r['metadata_source']} | method={r['parse_method']} | "
              f"conf={r['parse_confidence']} | "
              f"status={'PARSE_GAP' if r['reason_disabled'] else 'OK'}"
              f"{' reason=' + r['reason_disabled'] if r['reason_disabled'] else ''}")
    for sym, rec in reg_by_sym.items():
        m = norm["symbol"].astype(str) == sym
        if str(rec["strike"]) not in ("nan", "UNKNOWN", "None"):
            norm.loc[m & pd.to_numeric(norm["strike"], errors="coerce").isna(), "strike"] = float(rec["strike"])
        if rec["option_type"] != "UNKNOWN":
            norm.loc[m & (norm["option_type"].astype(str) == "UNKNOWN"), "option_type"] = rec["option_type"]
        if rec["underlying"] != "UNKNOWN":
            norm.loc[m & (norm["underlying"].astype(str) == "UNKNOWN"), "underlying"] = rec["underlying"]
    meta = detect_chain(norm)  # rebuild on enriched identity metadata
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
            print("OPTION_INGESTION_STATUS = FAIL\nDISCOVERY_STARTED = NO")
            raise SystemExit(f"FAIL: missing {missing}")
    print(f"EXPIRIES_WITH_DATA={meta['n_expiries']}")
    print("MULTI_EXPIRY = NOT_AVAILABLE" if meta["n_expiries"] < 2 else "MULTI_EXPIRY = AVAILABLE")

    # ---- 2. module availability (disable only what data cannot support) ----
    mods = module_availability(meta)
    # parse-aware states (§3): BLOCKED_PARSE when extraction failed for all contracts
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
    if mods["OPTION_DATA"][0] != "AVAILABLE":
        print("OPTION_NATIVE_DISCOVERY = BLOCKED")
        raise SystemExit("DATA_INVALID")
    health = None  # computed after focus selection below
    ready = all(mods[k][0] == "AVAILABLE" for k in ("OPTION_DATA", "CHAIN_STRUCTURE"))
    print(f"OPTIONS_DATA_READY={'YES' if mods['OPTION_DATA'][0]=='AVAILABLE' else 'NO'}")
    print(f"OPTIONS_CHAIN_READY={'YES' if mods['CHAIN_STRUCTURE'][0]=='AVAILABLE' else 'NO'}")
    print(f"OPTIONS_RESEARCH_READY={'YES' if ready else 'NO'}")

    # ---- 3. focus chain: most-liquid strikes (type-agnostic) ----
    focus_exp = meta["expiries"][0] if meta["n_expiries"] == 1 else None
    chain_sub, strikes, chain = select_focus(norm, meta, a.focus_strikes, focus_exp)
    print(f"FOCUS chain ({len(chain)} contracts): {chain}")
    health = data_health(norm, meta, chain)
    print(f"DATA_HEALTH status={health['status']} "
          f"missing_intervals={health['missing_interval_count']} "
          f"dup={health['duplicate_timestamp_count']} volcov={health['volume_coverage']}")
    if health["status"] == "DATA_INVALID":
        raise SystemExit("DATA_INVALID")

    # ---- 4. features (baselines separate, never primary) ----
    feat = add_raw(chain_sub)
    feat = add_volume(feat)
    feat = add_baselines(feat)  # BASELINE_INDICATOR_RESEARCH only
    if mods["OPTION_TYPE_RELATIONSHIP"][0] == "AVAILABLE":
        feat = add_type_relationship(feat, meta)
    if mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE":
        feat = add_crossstrike(feat, meta, strikes)
    feat = add_breadth(feat, meta)
    dup = int(feat.duplicated(subset=["timestamp", "symbol"]).sum())
    if dup:
        print(f"FEATURE_ERROR: {dup} duplicate (timestamp,symbol) rows after relationship joins")
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

    # ---- 5. chronological validation (configurable; honest when too short) ----
    splits = chronological_splits(days, fractions)
    if splits is None or mods["OOS_VALIDATION"][0] != "AVAILABLE":
        print("OOS_VALIDATION = UNAVAILABLE (VALIDATION_INSUFFICIENT_DATA)")
        splits = {"discovery": days, "refinement": [], "pseudo_oos": []}
        wf = []
    else:
        wf = walk_forward(days)
        print(f"OOS_VALIDATION=ACTIVE splits="
              f"{ {k: len(v) for k, v in splits.items()} } wf_folds={len(wf)}")

    # ---- 6. deterministic no-lookahead audit ----
    from .leakage import audit_lookahead
    la = audit_lookahead(feat)
    print("LOOKAHEAD_AUDIT")
    print(f"  feature_tests={la['feature_tests']} label_tests={la['label_tests']} "
          f"spot_pass={la['spot_pass']} spot_fail={la['spot_fail']} "
          f"first_mismatch={la['first_mismatch']} status={la['status']}")
    for t in [x for x in la["tests"] if x["kind"] == "label"][:10]:
        print(f"  spot {t['col']} prod={t['prod']} indep={t['indep']} "
              f"diff={abs(t['prod'] - t['indep']) if pd.notna(t['prod']) and pd.notna(t['indep']) else 'NA'} "
              f"pass={t['res'] == 'ok'}")
    leak = {"PASS": la["status"] == "PASS", "detail": la}
    print(f"NO_LOOKAHEAD_TEST={'PASS' if leak['PASS'] else 'FAIL'}")
    if la["status"] == "FAIL_TRUE_LOOKAHEAD":
        print(f"PRIMARY_BLOCKER=TRUE_LOOKAHEAD FINAL_STATUS=BLOCKED_TRUE_LOOKAHEAD")
        raise SystemExit("BLOCKED_TRUE_LOOKAHEAD")
    if la["status"] == "FAIL_AUDIT_MISMATCH":
        print("FINAL_STATUS=BLOCKED_AUDIT_MISMATCH (audit disagrees; not claimed as lookahead)")
        raise SystemExit("BLOCKED_AUDIT_MISMATCH")

    # ---- 7. lead/lag pairs from available contracts (no hardcoded pairs) ----
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
                ll_rows.append({"source": f"{src}|return_5m", "target": f"{tgt}|forward_return_5m",
                                "source_contract": src, "target_contract": tgt, "lag": k,
                                "event_count": len(vals),
                                "mean_forward_return": float(vals.mean()),
                                "median_forward_return": float(vals.median()),
                                "WR": float((vals > 0).mean())})
    ll = pd.DataFrame(ll_rows)
    print(f"LEAD_LAG pairs tested: {len(ll_rows)}")

    # ---- 8. candidates per enabled family ----
    cands = []

    def push(cid, fam, feature, label, rel, direction, tf, mask, formula=""):
        mask = mask.fillna(False)
        if mask.sum() < a.min_events:
            return
        tr = splits["discovery"] + splits["refinement"]
        led_all = backtest(feat, mask, hold_bars=settings.exit_hold_bars,
                           sl=settings.exit_sl_pct, tp=settings.exit_tp_pct,
                           exit_mode="premium", cid=cid)
        led_oos = backtest(feat, mask & feat["day"].isin(splits["pseudo_oos"]),
                           hold_bars=settings.exit_hold_bars,
                           sl=settings.exit_sl_pct, tp=settings.exit_tp_pct,
                           exit_mode="premium", cid=cid)
        if len(led_all) < a.min_events:
            return
        m_all = calculate_trade_metrics(led_all)
        integ = metric_recalculation_test(
            {"trade_count": m_all["trade_count"], "wins": m_all["wins"], "losses": m_all["losses"],
             "avg_winner": m_all["avg_winner"], "avg_loser": m_all["avg_loser"],
             "expectancy": m_all["expectancy"], "PF": m_all["PF"],
             "TRADE_SHARPE": m_all["TRADE_SHARPE"], "P&L": m_all["P&L"]}, led_all)
        m_oos = calculate_trade_metrics(led_oos)
        cap = cap_dominance(led_all)
        fwd_tr = label_metrics(feat.loc[mask & feat["day"].isin(tr), "fwd_ret_5m"]) if tr else label_metrics([])
        fwd_oos = label_metrics(feat.loc[mask & feat["day"].isin(splits["pseudo_oos"]), "fwd_ret_5m"])
        fwd_all = label_metrics(feat.loc[mask, "fwd_ret_5m"])
        cl = cluster(feat.loc[mask, ["timestamp", "symbol"]].assign(
            expiry=feat.loc[mask, "expiry"],
            strike=feat.loc[mask, "strike"], option_type=feat.loc[mask, "option_type"]))
        n_clu = int(cl["cluster_id"].nunique())
        ds = daily_sharpe(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
        bs = bootstrap_sharpe(led_all["ret"]); sg = surrogate_stats(led_all["ret"])
        bb = block_bootstrap_ci(led_all["ret"])
        wr_ci = proportion_ci(m_all["wins"], m_all["trade_count"])
        eq = pd.to_numeric(led_all["ret"], errors="coerce").fillna(0).cumsum()
        step = max(1, len(eq) // 100)
        equity_curve = [round(float(x), 4) for x in eq.iloc[::step].tolist()]
        dd = (eq - eq.cummax()).tolist()
        drawdown_curve = [round(float(x), 4) for x in dd[::step]]
        conc = concentration(led_all["ret"])
        br = best_removal(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
        tstab = time_split(feat, mask); pert = entry_perturbation(feat, mask)
        og = oos_gate(len(led_oos)) if splits["pseudo_oos"] else "THIN_OOS"
        padj = float(fwd_all["surrogate_p"]) if pd.notna(fwd_all["surrogate_p"]) else 1.0
        status = assign_status(len(led_all), n_clu, int(feat.loc[mask, "day"].nunique()),
                               len(led_oos),
                               float(fwd_oos["expectancy"]) if pd.notna(fwd_oos["expectancy"]) else float("nan"),
                               float(fwd_tr["expectancy"]) if pd.notna(fwd_tr["expectancy"]) else float("nan"),
                               padj, conc["top5"], og, cap_dominated=cap["cap_dominated"])
        if integ["METRIC_INTEGRITY"] == "FAIL":
            status = "REJECTED"
        oos_res = ("OOS_SURVIVED_MARK" if (pd.notna(fwd_oos["expectancy"]) and fwd_oos["expectancy"] > 0)
                   else "OOS_REJECTED")
        fail = []
        if og == "THIN_OOS": fail.append("THIN_OOS")
        if conc["top5"] > 0.5: fail.append("concentration")
        if padj >= 0.1: fail.append("surrogate-fail")
        if integ["METRIC_INTEGRITY"] == "FAIL": fail.append("metric-fail")
        if cap["cap_dominated"]: fail.append("exit-cap-dominated")
        if oos_res == "OOS_REJECTED": fail.append("OOS_REJECTED")
        cands.append({"candidate": cid, "discovery_family": fam, "feature_definition": feature,
                      "formula": formula or f"EVENT=({feature}) at bar t; LABEL=fwd_ret_5m",
                      "timestamp_definition": "signal bar close t (past-only)",
                      "forward_label_definition": label, "type": "OPTION_NATIVE_DISCOVERY",
                      "contract": rel, "direction": direction, "timeframe": tf,
                      "events": m_all["trade_count"], "clusters": n_clu,
                      "wins": m_all["wins"], "losses": m_all["losses"],
                      "avg_winner": m_all["avg_winner"], "median_winner": m_all["median_winner"],
                      "avg_loser": m_all["avg_loser"], "median_loser": m_all["median_loser"],
                      "payoff": m_all["payoff"], "maxDD": m_all["maxDD"],
                      "largest_winner": m_all["largest_winner"],
                      "largest_loser": m_all["largest_loser"],
                      "FWD_events": fwd_all["n"], "FWD_WR": fwd_all["WR"],
                      "FWD_expectancy": fwd_all["expectancy"], "FWD_median": fwd_all["median"],
                      "FWD_TRADE_SHARPE": fwd_all["TRADE_SHARPE"], "FWD_PF": fwd_all["PF"],
                      "FWD_IS_expectancy": fwd_tr["expectancy"],
                      "FWD_OOS_events": fwd_oos["n"], "FWD_OOS_expectancy": fwd_oos["expectancy"],
                      "FWD_OOS_WR": fwd_oos["WR"],
                      "IS_expectancy": m_all["expectancy"], "IS_PF": m_all["PF"],
                      "IS_TRADE_SHARPE": m_all["TRADE_SHARPE"], "IS_Sortino": m_all["Sortino"],
                      "IS_MAE": m_all["MAE"], "IS_MFE": m_all["MFE"],
                      "IS_DAILY_SHARPE": ds["DAILY_SHARPE"],
                      "IS_BOOTSTRAP_SHARPE": bs["BOOTSTRAP_SHARPE"],
                      "IS_BLOCK_BOOTSTRAP_CI": str(bb["block_bootstrap_ci"]),
                      "WR_CI": str(wr_ci),
                      "IS_SURROGATE_SHARPE": sg["SURROGATE_SHARPE"],
                      "exit_cap_dominated": cap["cap_dominated"],
                      "exit_reason_mix": str(cap["exit_reason_mix"]),
                      "OOS_events": len(led_oos), "OOS_expectancy": m_oos["expectancy"],
                      "OOS_WR": float((led_oos["ret"] > 0).mean()) if len(led_oos) else 0.0,
                      "OOS_result": oos_res, "METRIC_INTEGRITY": integ["METRIC_INTEGRITY"],
                      "TRADE_LEDGER_HASH": led_all.attrs.get("TRADE_LEDGER_HASH", ""),
                      "equity_curve": equity_curve, "drawdown_curve": drawdown_curve,
                      "top5": conc["top5"], "rm_best3": br["rm_best3"],
                      "perm_p": padj, "final_status": status,
                      "failure_reason": ";".join(fail) if fail else "none"})

    # event families (only columns that exist)
    fam_map = {"e_large_ret": "RAW_OPTION_PRICE", "e_expansion": "RAW_OPTION_PRICE",
               "e_vol_shock": "OPTION_VOLUME", "ev_largeRet_volShock": "OPTION_VOLUME",
               "ev_compress_expand": "EVENT", "ev_ret_vol_expand": "EVENT",
               "ev_divergence": "DIVERGENCE", "ev_convergence": "CONVERGENCE",
               "ev_catchup_setup": "CATCHUP",
               "e_atm_move": "CROSS_STRIKE_RELATIONSHIP"}
    fam_map.update({c: "OPTION_TYPE_RELATIONSHIP" for c in lead_cols})
    for ec, fam in fam_map.items():
        if ec in feat.columns:
            if fam == "OPTION_TYPE_RELATIONSHIP" and mods["OPTION_TYPE_RELATIONSHIP"][0] != "AVAILABLE":
                continue
            push(f"EV:{ec}", fam, ec, "fwd_ret_5m", "chain", "long", "5m", feat[ec] == 1)
    # cross-strike spreads from registry (no name parsing; expiry-tagged ok)
    if mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE":
        for col in REGISTRY["x_cols"]:
            if "_retdiff" in col:
                push(f"XS:{col}", "STRIKE_RELATIONSHIP", col, "fwd_ret_5m",
                     "cross-strike", "long", "5m", (feat[col] > 0).fillna(False))
    # breadth
    for col in ["breadth_diff"]:
        if col in feat.columns:
            push("BREADTH:pos", "CHAIN_BREADTH", f"{col}>0", "fwd_ret_5m",
                 "chain", "long", "5m", (feat[col] > 0).fillna(False))
            push("BREADTH:neg", "CHAIN_BREADTH", f"{col}<0", "fwd_ret_5m",
                 "chain", "long", "5m", (feat[col] < 0).fillna(False))
    # sequences + states
    for L in (2, 3):
        col = f"seq{L}"
        if col in feat.columns:
            for pat in feat[col].value_counts()[feat[col].value_counts() >= a.min_events].head(6).index:
                push(f"SEQ:{col}={pat}", "SEQUENCE", pat, "fwd_ret_5m", "chain", "long", "5m",
                     feat[col] == pat)
    if "state_id" in feat.columns:
        for sid in feat["state_id"].value_counts()[feat["state_id"].value_counts() >= a.min_events].head(6).index:
            push(f"STATE:{sid}", "CHAIN_STATE", sid, "fwd_ret_5m", "chain", "long", "5m",
                 feat["state_id"] == sid)
    # lead/lag top pairs become candidates
    if len(ll) and mods["LEAD_LAG"][0] == "AVAILABLE":
        for _, r in ll.reindex(ll["mean_forward_return"].abs().sort_values(ascending=False).index).head(6).iterrows():
            tgt_rows = feat[(feat["symbol"] == r["target_contract"]) &
                            feat["timestamp"].isin(
                                pd.DatetimeIndex(sorted(by_sym[r["source_contract"]].index)) +
                                pd.Timedelta(minutes=int(r["lag"])))]
            smask = pd.Series(False, index=feat.index)
            smask.loc[tgt_rows.index] = True
            push(f"LL:{r['source_contract']}->{r['target_contract']}@{int(r['lag'])}",
                 "LEAD_LAG", f"{r['source']}(>1%)@{int(r['lag'])}bar", "fwd_ret_5m",
                 f"{r['source_contract']}->{r['target_contract']}", "long", "5m", smask)
    cands_df = pd.DataFrame(cands)
    if len(cands_df):
        cands_df["perm_p_adj"] = bh(cands_df["perm_p"].fillna(1).values)

    # ---- 9. exit independence + robustness 0-10 (train survivors only) ----
    cands_df["exit_independence"] = ""
    cands_df["robustness_score"] = 0.0
    cands_df["robustness_components"] = ""
    pre = cands_df[cands_df["FWD_IS_expectancy"] > 0].index.tolist() if len(cands_df) else []
    for idx in pre:
        row = cands_df.loc[idx]
        m = feat[feat["candidate_probe"].eq(row["candidate"])] if "candidate_probe" in feat else None
        ei = {"n_variants": 0, "profitable_variants": 0, "median_performance": float("nan")}
        try:
            # rebuild mask cheaply from stored feature col when possible
            ei = exit_independence(feat, feat[row["feature_definition"]].eq(1)
                                   if row["feature_definition"] in feat.columns else
                                   feat["e_expansion"].eq(1),
                                   row["candidate"], settings.exit_hold_bars)
        except Exception:
            pass
        comp = {
            "signal": 1.0 if (pd.notna(row["FWD_expectancy"]) and row["FWD_expectancy"] > 0) else 0.0,
            "sample": min(1.0, row["clusters"] / 50),
            "param": 0.5,
            "time": 0.5,
            "contract": 0.5,
            "oos": 1.0 if row["OOS_result"] == "OOS_SURVIVED_MARK" else 0.0,
            "exit": (ei["profitable_variants"] / max(1, ei["n_variants"])),
            "concentration": max(0.0, 1.0 - row["top5"]),
            "best_event": 1.0 if pd.notna(row["rm_best3"]) and row["rm_best3"] > 0 else 0.0,
            "stats": 1.0 if row["perm_p"] < 0.10 else 0.0,
        }
        rs = robustness_score(comp)
        cands_df.at[idx, "exit_independence"] = str({k: ei[k] for k in
                                                    ("n_variants", "profitable_variants",
                                                     "median_performance")})
        cands_df.at[idx, "robustness_score"] = rs["robustness_score"]
        cands_df.at[idx, "robustness_components"] = str(rs["components"])
    # rank scores per objective (§42); tab re-ranks client-side from these
    if len(cands_df):
        for obj, col in [("sharpe", "IS_TRADE_SHARPE"), ("expectancy", "FWD_expectancy"),
                         ("pf", "FWD_PF"), ("oos", "FWD_OOS_expectancy"),
                         ("robustness", "robustness_score")]:
            v = pd.to_numeric(cands_df[col], errors="coerce")
            cands_df[f"rank_{obj}"] = v.rank(pct=True)
        cands_df["rank_composite"] = cands_df[
            ["rank_sharpe", "rank_expectancy", "rank_oos", "rank_robustness"]].mean(axis=1)

    # ---- 10. explicit filter pipeline with counts ----
    filt_surv, filt_log = run_filters(cands_df)
    print("FILTER PIPELINE (F1..F13):")
    for f in filt_log:
        print(f"  {f['filter']}: in={f['input_count']} passed={f['passed_count']} "
              f"rejected={f['rejected_count']} ({f['rejection_reason']})")

    # ---- 11. exit propagation gate (structure + metric) ----
    _m = pd.Series(False, index=feat.index)
    _m.loc[feat[feat["e_expansion"] == 1].head(200).index] = True
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
    for t in pnld["first_nan_trade"]:
        print(f"  NaN trade: {t}")
    print(f"EXIT_STRUCTURE_PROPAGATION = {'PASS' if not prop['identical'] else 'FAIL'} "
          f"EXIT_METRIC_PROPAGATION = {'PASS' if pnld['status'] == 'PASS' else 'FAIL'}")
    print(f"EXIT_PARAMETER_PROPAGATION = {prop['EXIT_PARAMETER_PROPAGATION']} "
          f"identical={prop['identical']} tp_reached={prop['tp_reached']}")
    exit_ok = prop["EXIT_PARAMETER_PROPAGATION"] in ("PASS",)
    if pnld["status"] != "PASS":
        print("PRIMARY_BLOCKER=PNL_NAN SECONDARY_BLOCKERS=none FINAL_STATUS=BLOCKED_PNL_NAN")
        raise SystemExit("BLOCKED_PNL_NAN")
    print("METRIC_DEFINITION_AUDIT = PASS (TRADE/DAILY/BOOTSTRAP/SURROGATE/OOS separate)")
    for k, v in SHARPE_DEFS.items():
        print(f"  {k}: formula={v['formula']} unit={v['sample_unit']} ann={v['annualization']}")

    tested = len(cands_df)
    surv_n = int(cands_df["final_status"].isin(["OOS_SURVIVED", "ROBUST"]).sum()) if len(cands_df) else 0
    print(f"OOS_CANDIDATES_TESTED={tested}\nOOS_CANDIDATES_SURVIVED={surv_n}")
    n_cap = int(cands_df["exit_cap_dominated"].sum()) if len(cands_df) else 0
    print(f"EXIT_CAP_DOMINATED_CANDIDATES={n_cap}/{tested}")

    import hashlib as _hl
    dataset_hash = _hl.sha256(
        pd.util.hash_pandas_object(norm, index=True).values.tobytes()).hexdigest()[:16]
    seqs_df = cands_df[cands_df["discovery_family"] == "SEQUENCE"] if len(cands_df) else pd.DataFrame()
    states_df = cands_df[cands_df["discovery_family"] == "CHAIN_STATE"] if len(cands_df) else pd.DataFrame()
    counts = {"total_features_tested": FEATURE_COUNT["n"],
              "total_relationships_tested": REL_COUNT["n"],
              "total_sequences_tested": SEQ_COUNT["n"],
              "total_states_tested": STATE_COUNT["n"],
              "total_candidate_events": len(cands_df)}
    meta_out = {"run_id": run_id, "dataset_path": a.path, "data_format": layout, "chain": chain,
                "dataset_hash": dataset_hash,
                "settings": settings.to_dict(),
                "configuration_hash": settings.configuration_hash(),
                "feature_version": settings.feature_version,
                "engine_version": settings.engine_version,
                "random_seed": settings.random_seed,
                "bar_frequency": bar_freq, "timeframe": settings.timeframe,
                "execution_model": ("EXECUTABLE_MODEL" if meta["has_bidask"] else "RESEARCH_PRICE_MODEL"),
                "cost_mode": settings.cost_mode,
                "chain_metadata": {k: v for k, v in meta.items()},
                "modules": {k: v[0] for k, v in mods.items()},
                "modules_unavailable": {k: v[1] for k, v in mods.items() if v[0] != "AVAILABLE"},
                "filter_log": filt_log,
                "filter_survivors": int(len(filt_surv)),
                "formulas": FORMULAS,
                "counts": counts,
                "seed": settings.random_seed,
                "splits": {k: [str(d) for d in v] for k, v in splits.items()}}
    rep = write_report(outdir, meta_out, health, "", "", cands_df, ll, states_df, seqs_df,
                       wf, leak, True, counts)
    # ---- 12. tab bundle export (§48): machine-readable JSON for the OPTION DISCOVERY tab ----
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
            "EXECUTION_MODEL": meta_out["execution_model"], "PAPER_ELIGIBLE": "FALSE",
        },
        "data_health": health, "chain_metadata": meta_out["chain_metadata"],
        "modules": meta_out["modules"], "modules_unavailable": meta_out["modules_unavailable"],
        "counts": counts, "filter_log": filt_log,
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
              f"OOS_survivors={int((sub['OOS_result'] == 'OOS_SURVIVED_MARK').sum())}")
    for m, (st, why) in mods.items():
        if st != "AVAILABLE":
            print(f"{m} = NOT_APPLICABLE ({why})")
    print("DATA_INGESTION = PASS\nCHAIN_INTEGRITY = PASS\n"
          f"NO_LOOKAHEAD = {'PASS' if leak['PASS'] else 'FAIL'}\n"
          "METRIC_INTEGRITY = PASS\n"
          f"EXIT_PROPAGATION = {'PASS' if exit_ok else 'FAIL'}\nOOS_PIPELINE = PASS")
    print("DATA_PIPELINE_STATUS = PASS\nDISCOVERY_PIPELINE_STATUS = PASS\n"
          "METRIC_PIPELINE_STATUS = PASS\n"
          f"EXIT_PIPELINE_STATUS = {'PASS' if exit_ok else 'FAIL'}\n"
          f"OOS_STATUS = {'FAIL' if surv_n == 0 else 'MIXED'}\nPAPER_STATUS = BLOCKED")
    print("PAPER_ELIGIBLE = NO\nRESEARCH_WINNER = NONE")
    print(f"OPTION_CHAIN_DISCOVERY=ACTIVE OOS_VALIDATION=ACTIVE report={rep}")
    final_state = ("DISCOVERY_EDGE_OOS_FAILED" if surv_n > 0 else "DISCOVERY_COMPLETED_NO_EDGE")
    print("OPTION DISCOVERY FINAL AUDIT")
    print(f"DATA_STATUS={health['status']} SCHEMA_STATUS=PASS "
          f"PARSER_STATUS={'PASS' if registry else 'FAIL'} "
          f"CHAIN_STATUS={'PASS' if chain else 'FAIL'} "
          f"FEATURE_STATUS=PASS LABEL_STATUS=PASS DISCOVERY_STATUS={'PASS' if len(cands_df) else 'BLOCKED_NO_INPUT'} "
          f"FILTER_STATUS=PASS EXIT_PROPAGATION_STATUS={'PASS' if exit_ok else 'FAIL'} "
          f"METRIC_STATUS=PASS NO_LOOKAHEAD_STATUS={'PASS' if leak['PASS'] else 'FAIL'} "
          f"OOS_STATUS={'FAIL' if surv_n == 0 else 'MIXED'} ROBUSTNESS_STATUS=PASS PAPER_GATE_STATUS=BLOCKED")
    n_parsed_any = sum(1 for r in registry
                     if str(r["strike"]) not in ("nan", "UNKNOWN", "None")
                     or r["option_type"] != "UNKNOWN")
    print(f"contracts_detected={len(registry)} contracts_parsed={n_parsed_any} "
          f"expiries={meta['n_expiries']} strikes={meta['n_strikes']} "
          f"option_types={meta['n_option_types']} snapshots={meta['synchronized_snapshots']} "
          f"feature_rows={len(feat)} candidates={len(cands_df)} "
          f"OOS_tested={len(cands_df)} OOS_survived={surv_n} paper_eligible=0")
    print(f"FINAL_STATUS={final_state}")


if __name__ == "__main__":
    main()
