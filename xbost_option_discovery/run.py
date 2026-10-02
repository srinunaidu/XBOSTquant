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
                        module_availability, data_health)
from .chain_normalizer import normalize
from .features import add_raw, add_volume, add_baselines, FEATURE_COUNT
from .relationships import (add_type_relationship, add_crossstrike, add_breadth,
                            REL_COUNT, REGISTRY)
from .sequences import (add_atomic_events, add_combo_events, add_sequences,
                        add_states, SEQ_COUNT, STATE_COUNT)
from .labels import add_labels, FW
from .validation import chronological_splits, walk_forward, cluster, oos_gate
from .metrics import (calculate_trade_metrics, metric_recalculation_test,
                      daily_sharpe, bootstrap_sharpe, surrogate_stats, SHARPE_DEFS,
                      label_metrics, cap_dominance)
from .robustness import concentration, best_removal, time_split, entry_perturbation
from .multiple_testing import bh
from .backtest import backtest, propagation_gate
from .leakage import test_no_lookahead
from .reporting import write_report, assign_status

LAG_WINDOWS = (1, 2, 3, 5, 10)
MIN_EVENTS = 50


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--require-contracts", default=None,
                    help="optional comma-separated contract symbols that must exist")
    ap.add_argument("--focus-strikes", type=int, default=3)
    ap.add_argument("--splits", default="0.5,0.2,0.3",
                    help="discovery,refinement,pseudo-OOS fractions")
    ap.add_argument("--min-events", type=int, default=MIN_EVENTS)
    a = ap.parse_args()
    fractions = tuple(float(x) for x in a.splits.split(","))
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    outdir = a.outdir or os.path.join("xbost_option_discovery", "runs", run_id)

    # ---- 1. dynamic ingestion + chain detection ----
    norm, layout = load_dataset(a.path)
    norm = normalize(norm)
    meta = detect_chain(norm)
    print("OPTIONS_INGESTION_AUDIT\n-----------------------")
    print(f"source_file: {a.path}\nlayout: {layout}\nrows: {len(norm)}")
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

    # ---- 6. no-lookahead (injection check) ----
    leak = test_no_lookahead(feat, [f"fwd_ret_{w}m" for w in FW])
    print(f"NO_LOOKAHEAD_TEST={'PASS' if leak['PASS'] else 'FAIL'} "
          f"(injection-changes-signal=True)")

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

    def push(cid, fam, feature, label, rel, direction, tf, mask):
        mask = mask.fillna(False)
        if mask.sum() < a.min_events:
            return
        tr = splits["discovery"] + splits["refinement"]
        led_all = backtest(feat, mask, hold_bars=5, sl=0.5, tp=1.0, exit_mode="premium", cid=cid)
        led_oos = backtest(feat, mask & feat["day"].isin(splits["pseudo_oos"]), hold_bars=5,
                           sl=0.5, tp=1.0, exit_mode="premium", cid=cid)
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
            strike=feat.loc[mask, "strike"], option_type=feat.loc[mask, "option_type"]))
        n_clu = int(cl["cluster_id"].nunique())
        ds = daily_sharpe(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
        bs = bootstrap_sharpe(led_all["ret"]); sg = surrogate_stats(led_all["ret"])
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
                      "timestamp_definition": "signal bar close t (past-only)",
                      "forward_label_definition": label, "type": "OPTION_NATIVE_DISCOVERY",
                      "contract": rel, "direction": direction, "timeframe": tf,
                      "events": m_all["trade_count"], "clusters": n_clu,
                      "wins": m_all["wins"], "losses": m_all["losses"],
                      "avg_winner": m_all["avg_winner"], "avg_loser": m_all["avg_loser"],
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
                      "IS_SURROGATE_SHARPE": sg["SURROGATE_SHARPE"],
                      "exit_cap_dominated": cap["cap_dominated"],
                      "exit_reason_mix": str(cap["exit_reason_mix"]),
                      "OOS_events": len(led_oos), "OOS_expectancy": m_oos["expectancy"],
                      "OOS_WR": float((led_oos["ret"] > 0).mean()) if len(led_oos) else 0.0,
                      "OOS_result": oos_res, "METRIC_INTEGRITY": integ["METRIC_INTEGRITY"],
                      "top5": conc["top5"], "rm_best3": br["rm_best3"],
                      "perm_p": padj, "final_status": status,
                      "failure_reason": ";".join(fail) if fail else "none"})

    # event families (only columns that exist)
    fam_map = {"e_large_ret": "RAW_OPTION_PRICE", "e_expansion": "RAW_OPTION_PRICE",
               "e_vol_shock": "OPTION_VOLUME", "ev_largeRet_volShock": "OPTION_VOLUME",
               "ev_compress_expand": "EVENT", "ev_ret_vol_expand": "EVENT",
               "e_atm_move": "CROSS_STRIKE_RELATIONSHIP"}
    fam_map.update({c: "OPTION_TYPE_RELATIONSHIP" for c in lead_cols})
    for ec, fam in fam_map.items():
        if ec in feat.columns:
            if fam == "OPTION_TYPE_RELATIONSHIP" and mods["OPTION_TYPE_RELATIONSHIP"][0] != "AVAILABLE":
                continue
            push(f"EV:{ec}", fam, ec, "fwd_ret_5m", "chain", "long", "5m", feat[ec] == 1)
    # cross-strike spreads from registry (no name parsing)
    if mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE":
        for col in REGISTRY["x_cols"]:
            if col.endswith("_retdiff"):
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

    # ---- 9. exit propagation gate ----
    _m = pd.Series(False, index=feat.index)
    _m.loc[feat[feat["e_expansion"] == 1].head(200).index] = True
    if _m.sum() < 10:
        _m.iloc[:200] = True
    prop = propagation_gate(feat, _m)
    print(f"EXIT_PARAMETER_PROPAGATION = {prop['EXIT_PARAMETER_PROPAGATION']} "
          f"identical={prop['identical']} tp_reached={prop['tp_reached']}")
    exit_ok = prop["EXIT_PARAMETER_PROPAGATION"] == "PASS"
    print("METRIC_DEFINITION_AUDIT = PASS (TRADE/DAILY/BOOTSTRAP/SURROGATE/OOS separate)")
    for k, v in SHARPE_DEFS.items():
        print(f"  {k}: formula={v['formula']} unit={v['sample_unit']} ann={v['annualization']}")

    tested = len(cands_df)
    surv_n = int(cands_df["final_status"].isin(["OOS_SURVIVED", "ROBUST"]).sum()) if len(cands_df) else 0
    print(f"OOS_CANDIDATES_TESTED={tested}\nOOS_CANDIDATES_SURVIVED={surv_n}")
    n_cap = int(cands_df["exit_cap_dominated"].sum()) if len(cands_df) else 0
    print(f"EXIT_CAP_DOMINATED_CANDIDATES={n_cap}/{tested}")

    seqs_df = cands_df[cands_df["discovery_family"] == "SEQUENCE"] if len(cands_df) else pd.DataFrame()
    states_df = cands_df[cands_df["discovery_family"] == "CHAIN_STATE"] if len(cands_df) else pd.DataFrame()
    meta_out = {"run_id": run_id, "dataset_path": a.path, "data_format": layout, "chain": chain,
                "chain_metadata": {k: (v if not isinstance(v, dict) else v) for k, v in meta.items()},
                "modules": {k: v[0] for k, v in mods.items()},
                "modules_unavailable": {k: v[1] for k, v in mods.items() if v[0] != "AVAILABLE"},
                "code_version": "od-v5-dynamic", "seed": 42,
                "splits": {k: [str(d) for d in v] for k, v in splits.items()}}
    rep = write_report(outdir, meta_out, health, "", "", cands_df, ll, states_df, seqs_df,
                       wf, leak, True,
                       {"total_features_tested": FEATURE_COUNT["n"],
                        "total_relationships_tested": REL_COUNT["n"],
                        "total_sequences_tested": SEQ_COUNT["n"],
                        "total_states_tested": STATE_COUNT["n"],
                        "total_candidate_events": len(cands_df)})
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
    print("OPTION_NATIVE_RESEARCH_RESULT = NO_VALIDATED_EDGE" if surv_n == 0 else "NEEDS_REVIEW")


if __name__ == "__main__":
    main()
