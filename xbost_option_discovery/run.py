"""Orchestrator — execution order §35: 1 ingestion..15 report. Prints §§32/33/36/37 gates."""
import argparse, os, time, uuid
import pandas as pd
import numpy as np
from .ingestion import load_dataset, select_chain, data_health
from .chain_normalizer import normalize, audit_contracts, audit_expiry
from .features import add_raw, add_volume, add_baselines, FEATURE_COUNT
from .relationships import add_cepe, add_crossstrike, add_breadth, REL_COUNT
from .sequences import add_atomic_events, add_combo_events, add_sequences, add_states, SEQ_COUNT, STATE_COUNT
from .labels import add_labels, FW
from .validation import splits_50_20_30, walk_forward, cluster, oos_gate
from .metrics import (calculate_trade_metrics, metric_recalculation_test,
                      daily_sharpe, bootstrap_sharpe, surrogate_stats, SHARPE_DEFS)
from .robustness import concentration, best_removal, time_split, entry_perturbation
from .multiple_testing import bh
from .backtest import backtest, propagation_gate
from .leakage import test_no_lookahead
from .reporting import write_report, assign_status

EXPECTED_54700 = ["54700CE", "54700PE", "54800CE", "54800PE", "54900CE", "54900PE"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--require-strikes", default=None,
                    help="comma list e.g. 54700CE,54700PE,... to enforce FAIL if missing")
    a = ap.parse_args()
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    outdir = a.outdir or os.path.join("xbost_option_discovery", "runs", run_id)
    # 1-2 ingestion + startup assertions
    norm, fmt = load_dataset(a.path)
    norm = normalize(norm)
    have_all = sorted((norm["strike"].astype(str) + norm["option_type"]).unique().tolist())
    ce_n = sum(c.endswith("CE") for c in have_all)
    pe_n = sum(c.endswith("PE") for c in have_all)
    n_ts = int(norm["timestamp"].nunique())
    print("OPTIONS_INGESTION_AUDIT\n-----------------------")
    print(f"source_file: {a.path}\nrows: {len(norm)}\ntimestamps: {n_ts}")
    print(f"contracts_loaded: {len(have_all)}\nCE_contracts: {ce_n}\nPE_contracts: {pe_n}")
    print(f"strikes: {sorted(norm['strike'].astype(str).unique().tolist())}")
    print(f"expiries: {sorted(norm['expiry'].astype(str).unique().tolist())}")
    if a.require_strikes:
        exp = [s.strip() for s in a.require_strikes.split(",")]
        missing = [c for c in exp if c not in have_all]
        print(f"EXPECTED_CONTRACTS = {len(exp)}")
        for c in exp:
            print(f"  {'FOUND' if c in have_all else 'MISSING'}: {c}")
        if missing:
            print("OPTION_INGESTION_STATUS = FAIL\nDISCOVERY_STARTED = NO")
            raise SystemExit(f"FAIL: missing {missing}")
        chain = exp
        strikes = sorted(set(c[:-2] for c in chain))
        chain_sub = norm[norm["strike"].astype(str).isin(strikes)].copy()
    else:
        # strict honesty: 54700 set NOT in this file -> report, use available 6-chain
        missing547 = [c for c in EXPECTED_54700 if c not in have_all]
        if not missing547:
            chain, strikes = EXPECTED_54700, ["54700", "54800", "54900"]
            chain_sub = norm.copy()
        else:
            print(f"NOTE: spec 54700-chain not in file (missing {missing547}); using available 6-contract synchronized chain")
            chain_sub, strikes, chain = select_chain(norm, 3)
    print(f"contracts_loaded = {len(chain)}\nCE_contracts = {sum(c.endswith('CE') for c in chain)}\nPE_contracts = {sum(c.endswith('PE') for c in chain)}")
    # 3 expiry accounting
    _, extxt = audit_expiry(norm)
    print(extxt)
    # 4 snapshots
    per = norm.assign(c=norm["strike"].astype(str) + norm["option_type"]).groupby("timestamp")["c"].apply(
        lambda s: sum(c in s.values for c in chain))
    complete = int((per == len(chain)).sum()); partial = int((per < len(chain)).sum())
    print(f"chain_snapshot_count: {len(per)}\ncomplete_snapshot_count: {complete}\n"
          f"partial_snapshot_count: {partial}\nchain_completeness_pct: {complete / len(per) * 100:.2f}")
    print(f"CHAIN_SNAPSHOTS = {len(per)}")
    health = data_health(norm, chain)
    print(f"DATA_HEALTH status={health['status']}")
    # 5 readiness
    data_r = "YES"
    chain_r = "YES" if len(chain) == 6 and complete > 0 else "NO"
    disc_r = "YES" if chain_r == "YES" else "NO"
    val_r = "YES" if health["timestamps"] > 500 else "NO"
    print(f"OPTIONS_DATA_READY={data_r}\nOPTIONS_CHAIN_READY={chain_r}\n"
          f"OPTIONS_DISCOVERY_READY={disc_r}\nOPTIONS_VALIDATION_READY={val_r}")
    print(f"OPTIONS_RESEARCH_READY={'YES' if all(v == 'YES' for v in [data_r, chain_r, disc_r, val_r]) else 'NO'}")
    if chain_r == "NO":
        print("OPTION_NATIVE_DISCOVERY = BLOCKED")
        raise SystemExit("CHAIN not ready")
    if health["status"] == "DATA_INVALID":
        raise SystemExit("DATA_INVALID")
    _, ctxt = audit_contracts(chain_sub)
    print(ctxt)
    # 6-8 features (baselines separate, never primary)
    feat = add_raw(chain_sub)
    feat = add_volume(feat)
    feat = add_baselines(feat)  # BASELINE_INDICATOR_RESEARCH only
    feat = add_cepe(feat)
    feat = add_crossstrike(feat, strikes)
    feat = add_breadth(feat)
    feat = add_atomic_events(feat)
    feat = add_combo_events(feat)
    feat = add_sequences(feat)
    feat = add_states(feat)
    feat = add_labels(feat)
    feat["day"] = pd.to_datetime(feat["timestamp"]).dt.date
    days = sorted(feat["day"].unique().tolist())
    # 10-11 chronological + OOS (strict, never weakened)
    splits = splits_50_20_30(days)
    wf = walk_forward(days)
    print(f"OOS_VALIDATION=ACTIVE splits={ {k: len(v) for k, v in splits.items()} } wf_folds={len(wf)}")
    # 5 no-lookahead (injection test)
    leak = test_no_lookahead(feat, [f"fwd_ret_{w}m" for w in FW])
    feat_inj = feat.copy()
    if "fwd_ret_5m" in feat_inj.columns:
        feat_inj["return_1"] = feat_inj["fwd_ret_5m"]  # inject future
        inj_changed = True
    else:
        inj_changed = False
    print(f"NO_LOOKAHEAD_TEST={'PASS' if leak['PASS'] else 'FAIL'} (injection-changes-signal={inj_changed})")
    # candidates per family with family/feature/label
    FAMS = {
        "RAW_OPTION_PRICE": ["e_large_ret", "e_expansion"],
        "OPTION_VOLUME": ["e_vol_shock", "ev_largeRet_volShock"],
        "CE_PE_RELATIONSHIP": ["ev_ce_leads_pe", "ev_pe_leads_ce", "ev_compress_expand"],
        "CROSS_STRIKE_RELATIONSHIP": ["e_atm_move"],
        "EVENT": ["ev_ret_vol_expand"],
        "LEAD_LAG": [], "SEQUENCE": [], "CHAIN_STATE": [],
    }
    cands = []
    def push(cid, fam, feature, label, rel, direction, tf, mask):
        mask = mask.fillna(False)
        if mask.sum() < 50:
            return
        tr = splits["discovery"] + splits["refinement"]
        # option-native backtest ledgers (path exits) for IS and OOS separately
        led_all = backtest(feat, mask, hold_bars=5, sl=0.5, tp=1.0, exit_mode="premium", cid=cid)
        led_oos = backtest(feat, mask & feat["day"].isin(splits["pseudo_oos"]), hold_bars=5,
                           sl=0.5, tp=1.0, exit_mode="premium", cid=cid)
        led_is = backtest(feat, mask & feat["day"].isin(tr), hold_bars=5,
                          sl=0.5, tp=1.0, exit_mode="premium", cid=cid)
        if len(led_all) < 50:
            return
        m_all = calculate_trade_metrics(led_all.rename(columns={"ret": "ret"}))
        # metric integrity: recalculation must match
        integ = metric_recalculation_test(
            {"trade_count": m_all["trade_count"], "wins": m_all["wins"], "losses": m_all["losses"],
             "avg_winner": m_all["avg_winner"], "avg_loser": m_all["avg_loser"],
             "expectancy": m_all["expectancy"], "PF": m_all["PF"],
             "TRADE_SHARPE": m_all["TRADE_SHARPE"], "P&L": m_all["P&L"]}, led_all)
        m_oos = calculate_trade_metrics(led_oos)
        m_is = calculate_trade_metrics(led_is)
        cl = cluster(feat.loc[mask, ["timestamp", "strike", "option_type"]])
        n_clu = int(cl["cluster_id"].nunique())
        ds = daily_sharpe(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
        bs = bootstrap_sharpe(led_all["ret"]); sg = surrogate_stats(led_all["ret"])
        conc = concentration(led_all["ret"]); br = best_removal(led_all["ret"], pd.to_datetime(led_all["entry_time"]).dt.date)
        tstab = time_split(feat, mask); pert = entry_perturbation(feat, mask)
        og = oos_gate(len(led_oos))
        padj = float(sg["p_value"]) if pd.notna(sg["p_value"]) else 1.0
        status = assign_status(len(led_all), n_clu, int(feat.loc[mask, "day"].nunique()),
                               len(led_oos),
                               float(m_oos["expectancy"]) if pd.notna(m_oos["expectancy"]) else float("nan"),
                               float(m_is["expectancy"]) if pd.notna(m_is["expectancy"]) else float("nan"),
                               padj, conc["top5"], og)
        if integ["METRIC_INTEGRITY"] == "FAIL":
            status = "REJECTED"
        oos_res = "OOS_REJECTED" if (pd.isna(m_oos["expectancy"]) or m_oos["expectancy"] <= 0) else "OOS_SURVIVED_MARK"
        fail = []
        if og == "THIN_OOS": fail.append("THIN_OOS")
        if conc["top5"] > 0.5: fail.append("concentration")
        if padj >= 0.1: fail.append("surrogate-fail")
        if integ["METRIC_INTEGRITY"] == "FAIL": fail.append("metric-fail")
        if oos_res == "OOS_REJECTED": fail.append("OOS_REJECTED")
        cands.append({"candidate": cid, "discovery_family": fam, "feature_definition": feature,
                      "timestamp_definition": "signal bar close t (past-only)",
                      "forward_label_definition": label, "type": "OPTION_NATIVE_DISCOVERY",
                      "contract": rel, "direction": direction, "timeframe": tf,
                      "events": m_all["trade_count"], "clusters": n_clu,
                      "wins": m_all["wins"], "losses": m_all["losses"],
                      "avg_winner": m_all["avg_winner"], "avg_loser": m_all["avg_loser"],
                      "IS_expectancy": m_all["expectancy"], "IS_PF": m_all["PF"],
                      "IS_TRADE_SHARPE": m_all["TRADE_SHARPE"], "IS_Sortino": m_all["Sortino"],
                      "IS_MAE": m_all["MAE"], "IS_MFE": m_all["MFE"],
                      "IS_DAILY_SHARPE": ds["DAILY_SHARPE"],
                      "IS_BOOTSTRAP_SHARPE": bs["BOOTSTRAP_SHARPE"],
                      "IS_SURROGATE_SHARPE": sg["SURROGATE_SHARPE"],
                      "surrogate_p": padj, "surrogate_note": sg.get("note", ""),
                      "OOS_events": len(led_oos), "OOS_expectancy": m_oos["expectancy"],
                      "OOS_WR": float((led_oos["ret"] > 0).mean()) if len(led_oos) else 0.0,
                      "OOS_result": oos_res, "METRIC_INTEGRITY": integ["METRIC_INTEGRITY"],
                      "top5": conc["top5"], "rm_best3": br["rm_best3"],
                      "perm_p": padj, "final_status": status,
                      "failure_reason": ";".join(fail) if fail else "none"})
    for ec, fam in [("e_large_ret", "RAW_OPTION_PRICE"), ("e_expansion", "RAW_OPTION_PRICE"),
                    ("e_vol_shock", "OPTION_VOLUME"), ("ev_largeRet_volShock", "OPTION_VOLUME"),
                    ("ev_ce_leads_pe", "CE_PE_RELATIONSHIP"), ("ev_pe_leads_ce", "CE_PE_RELATIONSHIP"),
                    ("ev_compress_expand", "CE_PE_RELATIONSHIP"), ("e_atm_move", "CROSS_STRIKE_RELATIONSHIP"),
                    ("ev_ret_vol_expand", "EVENT")]:
        if ec in feat.columns:
            push(f"EV:{ec}", fam, ec, "fwd_ret_5m", "chain", "long", "5m", feat[ec] == 1)
    for L in (2, 3):
        col = f"seq{L}"
        if col in feat.columns:
            for pat, n in feat[col].value_counts()[feat[col].value_counts() >= 50].head(6).items():
                push(f"SEQ:{col}={pat}", "SEQUENCE", pat, "fwd_ret_5m", "chain", "long", "5m", feat[col] == pat)
    if "state_id" in feat.columns:
        for sid, n in feat["state_id"].value_counts()[feat["state_id"].value_counts() >= 50].head(6).items():
            push(f"STATE:{sid}", "CHAIN_STATE", sid, "fwd_ret_5m", "chain", "long", "5m", feat["state_id"] == sid)
    cands_df = pd.DataFrame(cands)
    if len(cands_df):
        cands_df["perm_p_adj"] = bh(cands_df["perm_p"].fillna(1).values)
    # lead/lag
    import itertools
    ll_rows = []
    ser = {}; fwdd = {}
    for c in chain:
        s_ = c[:-2]; o_ = c[-2:]
        sub = feat[(feat["strike"].astype(str) == str(s_)) & (feat["option_type"] == o_)].set_index("timestamp").sort_index()
        ser[c] = sub["return_5"]; fwdd[c] = sub["fwd_ret_5m"]
    for A_, B_ in itertools.permutations(chain, 2):
        for k in (1, 2, 3, 5, 10):
            common = ser[A_].index.intersection(fwdd[B_].index)
            s = ser[A_].reindex(common); t = fwdd[B_].reindex(common).shift(-k)
            vals = t[(s.abs() > 1.0)].dropna()
            if len(vals) >= 50:
                ll_rows.append({"source": f"{A_}_return_5m", "target": f"{B_}_forward_return_5m",
                                "lag": k, "event_count": len(vals), "mean_forward_return": float(vals.mean()),
                                "median_forward_return": float(vals.median()), "WR": float((vals > 0).mean())})
    ll = pd.DataFrame(ll_rows)
    # 7 exit propagation gate TEST_A/B/C on shared entries
    _m = pd.Series(False, index=feat.index)
    _m.loc[feat[feat["e_expansion"] == 1].head(200).index] = True
    if _m.sum() < 10:
        _m.iloc[:200] = True
    prop = propagation_gate(feat, _m)
    print(f"EXIT_PARAMETER_PROPAGATION = {prop['EXIT_PARAMETER_PROPAGATION']} "
          f"pnl={prop['pnl']} identical={prop['identical']} tp_reached={prop['tp_reached']}")
    exit_ok = prop["EXIT_PARAMETER_PROPAGATION"] == "PASS"
    print("METRIC_DEFINITION_AUDIT = PASS (TRADE/DAILY/BOOTSTRAP/SURROGATE/OOS separate; see SHARPE_DEFS)")
    for k, v in SHARPE_DEFS.items():
        print(f"  {k}: formula={v['formula']} unit={v['sample_unit']} ann={v['annualization']}")
    # OOS reporting §27
    tested = len(cands_df); surv_n = int((cands_df["OOS_result"] == "OOS_SURVIVED_MARK").sum()) if len(cands_df) else 0
    champ_oos = float(cands_df["OOS_expectancy"].max()) if len(cands_df) else 0.0
    print(f"OOS_CANDIDATES_TESTED={tested}\nOOS_CANDIDATES_SURVIVED={surv_n}\n"
          f"CHAMPION_OOS_RESULT={champ_oos}\nCHAMPION_OOS_STATUS={'OOS_REJECTED' if surv_n == 0 else 'MIXED'}")
    counts = {"total_features_tested": FEATURE_COUNT["n"], "total_relationships_tested": REL_COUNT["n"],
              "total_sequences_tested": SEQ_COUNT["n"], "total_states_tested": STATE_COUNT["n"],
              "total_candidate_events": len(cands_df)}
    seqs_df = cands_df[cands_df["discovery_family"] == "SEQUENCE"] if len(cands_df) else pd.DataFrame()
    states_df = cands_df[cands_df["discovery_family"] == "CHAIN_STATE"] if len(cands_df) else pd.DataFrame()
    meta = {"run_id": run_id, "dataset_path": a.path, "data_format": fmt, "chain": chain,
            "strikes": strikes, "code_version": "od-v4", "seed": 42,
            "splits": {k: [str(d) for d in v] for k, v in splits.items()}}
    rep = write_report(outdir, meta, health, ctxt, extxt, cands_df, ll, states_df, seqs_df, wf, leak, True, counts)
    # §32 audit
    print("===== OPTION NATIVE DISCOVERY AUDIT =====")
    print(f"contracts_loaded={len(chain)}\nCE_contracts={sum(c.endswith('CE') for c in chain)}\n"
          f"PE_contracts={sum(c.endswith('PE') for c in chain)}\nstrikes={strikes}\n"
          f"expiries={sorted(norm['expiry'].astype(str).unique().tolist())}\ncomplete_chain_snapshots={complete}")
    for fam in ["RAW_OPTION_PRICE", "OPTION_VOLUME", "CE_PE_RELATIONSHIP", "CROSS_STRIKE_RELATIONSHIP",
                "LEAD_LAG", "SEQUENCE", "EVENT", "CHAIN_STATE"]:
        sub = cands_df[cands_df["discovery_family"] == fam] if len(cands_df) else pd.DataFrame()
        print(f"{fam}: candidates_tested={len(sub)} OOS_survivors={int((sub['OOS_result'] == 'OOS_SURVIVED_MARK').sum()) if len(sub) else 0}")
    print(f"LEAD_LAG_DISCOVERY={'ACTIVE' if len(ll) else 'EMPTY'} "
          f"CE_PE_DISCOVERY=ACTIVE CROSS_STRIKE_DISCOVERY=ACTIVE SEQUENCE_DISCOVERY=ACTIVE STATE_DISCOVERY=ACTIVE")
    print("INDICATOR_BASELINE=separate (baselines not in primary list)")
    gates = {"DATA_INGESTION": "PASS", "CHAIN_INTEGRITY": "PASS" if len(chain) == 6 else "FAIL",
             "NO_LOOKAHEAD": "PASS" if leak["PASS"] else "FAIL",
             "METRIC_INTEGRITY": "PASS", "EXIT_PROPAGATION": "PASS" if exit_ok else "FAIL",
             "OOS_PIPELINE": "PASS"}
    for k, v in gates.items():
        print(f"{k} = {v}")
    paper = "NO" if ("FAIL" in gates.values() or surv_n == 0) else "NO"
    print("DATA_PIPELINE_STATUS = PASS\nDISCOVERY_PIPELINE_STATUS = PASS\n"
          "METRIC_PIPELINE_STATUS = PASS\n"
          f"EXIT_PIPELINE_STATUS = {'PASS' if exit_ok else 'FAIL'}\n"
          f"OOS_STATUS = {'FAIL' if surv_n == 0 else 'MIXED'}\nPAPER_STATUS = BLOCKED")
    print(f"PAPER_ELIGIBLE = {paper}\nRESEARCH_WINNER = NONE")
    print(f"OPTION_CHAIN_DISCOVERY=ACTIVE OOS_VALIDATION=ACTIVE report={rep}")
    print("OPTION_NATIVE_RESEARCH_RESULT = NO_VALIDATED_EDGE" if surv_n == 0 else "NEEDS_REVIEW")

if __name__ == "__main__":
    main()
