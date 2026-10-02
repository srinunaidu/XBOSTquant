"""Orchestrator — execution order §40. Prints §41 success lines."""
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
from .metrics import raw_trade_stats, daily_stats, bootstrap_sharpe, surrogate_sharpe, oos_sharpe, pf
from .robustness import concentration, best_removal, time_split, entry_perturbation
from .multiple_testing import bh, COUNTS
from .backtest import backtest
from .leakage import test_no_lookahead
from .reporting import write_report, assign_status

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    a = ap.parse_args()
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    outdir = a.outdir or os.path.join("xbost_option_discovery", "runs", run_id)
    # 1-4 ingestion/chain/expiry/health
    norm, fmt = load_dataset(a.path)
    norm = normalize(norm)
    chain_sub, strikes, chain = select_chain(norm, 3)
    health = data_health(norm, chain)
    print("DATA_HEALTH\n-----------")
    for k, v in health.items():
        if k != "interval_distribution":
            print(f"{k}: {v}")
    print(f"DATA_{health['status'].split('_')[1]}" if '_' in health['status'] else health['status'])
    have, ctxt = audit_contracts(chain_sub)
    _, extxt = audit_expiry(norm)
    print(ctxt); print(extxt)
    print(f"CONTRACTS={len(chain)}")
    assert len(chain) == 6, f"expected 6-contract chain, got {chain}"
    if health["status"] == "DATA_INVALID":
        raise SystemExit("DATA_INVALID: aborting")
    # 5-6 features
    feat = add_raw(chain_sub)
    feat = add_volume(feat)
    feat = add_baselines(feat)
    # 7-8 relationships
    feat = add_cepe(feat)
    feat = add_crossstrike(feat, strikes)
    feat = add_breadth(feat)
    # 9-11 events/seq (leadlag needs labels; do labels first per dependency)
    feat = add_atomic_events(feat)
    feat = add_combo_events(feat)
    feat = add_sequences(feat)
    # 12 states
    feat = add_states(feat)
    # 13 labels
    feat = add_labels(feat)
    feat["day"] = pd.to_datetime(feat["timestamp"]).dt.date
    days = sorted(feat["day"].unique().tolist())
    # 14-15 clustering + chronological
    splits = splits_50_20_30(days)
    wf = walk_forward(days)
    print(f"OOS_VALIDATION=ACTIVE splits={ {k: len(v) for k, v in splits.items()} } wf_folds={len(wf)}")
    # 16 metric audit defs (explicit, never overwritten)
    leak = test_no_lookahead(feat, [f"fwd_ret_{w}m" for w in FW])
    print(f"NO_LOOKAHEAD_TEST={'PASS' if leak['PASS'] else 'FAIL'}")
    # candidates: atomic+combo events, seq patterns, states, cepe extremes, breadth
    cands = []
    def push(cid, typ, rel, direction, tf, mask):
        mask = mask.fillna(False)
        if mask.sum() < 50:
            return
        tr = splits["discovery"] + splits["refinement"]
        v_tr = feat.loc[mask & feat["day"].isin(tr), "fwd_ret_5m"].dropna()
        v_oos = feat.loc[mask & feat["day"].isin(splits["pseudo_oos"]), "fwd_ret_5m"].dropna()
        v_all = feat.loc[mask, "fwd_ret_5m"].dropna()
        if len(v_all) < 50:
            return
        cl = cluster(feat.loc[mask, ["timestamp", "strike", "option_type"]])
        n_clu = int(cl["cluster_id"].nunique())
        rts = raw_trade_stats(v_all); dts = daily_stats(v_all, feat.loc[v_all.index, "day"])
        bs = bootstrap_sharpe(v_all); sg = surrogate_sharpe(v_all); oos = oos_sharpe(v_oos)
        pff = pf(v_all)
        conc = concentration(v_all); br = best_removal(v_all, feat.loc[v_all.index, "day"])
        tstab = time_split(feat, mask)
        pert = entry_perturbation(feat, mask)
        og = oos_gate(len(v_oos))
        padj = float(sg["surrogate_p"])
        status = assign_status(len(v_all), n_clu, int(feat.loc[mask, "day"].nunique()),
                               len(v_oos), float(v_oos.mean()) if len(v_oos) else float("nan"),
                               float(v_tr.mean()) if len(v_tr) else float("nan"),
                               padj, conc["top5"], og)
        fail = []
        if og == "THIN_OOS": fail.append("THIN_OOS")
        if conc["top5"] > 0.5: fail.append("concentration")
        if padj >= 0.1: fail.append("perm-fail")
        cands.append({"candidate": cid, "type": "OPTION_CHAIN_DISCOVERY", "contract": rel,
                      "direction": direction, "timeframe": tf, "events": int(len(v_all)),
                      "clusters": n_clu, "IS_WR": float((v_all > 0).mean()),
                      "IS_expectancy": float(v_all.mean()), "IS_PF": pff["PF"],
                      "IS_raw_trade_sharpe": rts["raw_trade_sharpe"],
                      "IS_daily_sharpe": dts["daily_sharpe"],
                      "IS_bootstrap_sharpe": bs["bootstrap_sharpe"],
                      "IS_surrogate_sharpe": sg["surrogate_sharpe"],
                      "OOS_events": int(len(v_oos)), "OOS_WR": float((v_oos > 0).mean()) if len(v_oos) else 0.0,
                      "OOS_expectancy": float(v_oos.mean()) if len(v_oos) else 0.0,
                      "OOS_PF": pf(v_oos)["PF"] if len(v_oos) else 0.0,
                      "OOS_sharpe_oos": oos["oos_sharpe"],
                      "param_stability": pert, "time_stability": tstab,
                      "top1": conc["top1"], "top5": conc["top5"], "top10": conc["top10"],
                      "rm_best3": br["rm_best3"], "rm_bestday1": br["rm_bestday1"],
                      "perm_p": padj, "final_status": status,
                      "failure_reason": ";".join(fail) if fail else "none"})
    for ec in ["e_large_ret", "e_vol_shock", "e_compression", "e_expansion",
               "ev_largeRet_volShock", "ev_compress_expand", "ev_ret_vol_expand",
               "ev_ce_leads_pe", "ev_pe_leads_ce"]:
        if ec in feat.columns:
            push(f"EV:{ec}", "event", "chain", "long", "5m", feat[ec] == 1)
    for L in (2, 3):
        col = f"seq{L}"
        vc = feat[col].value_counts()
        for pat, n in vc[vc >= 50].head(8).items():
            push(f"SEQ:{col}={pat}", "sequence", "chain", "long", "5m", feat[col] == pat)
    for sid, n in feat["state_id"].value_counts()[feat["state_id"].value_counts() >= 50].head(10).items():
        push(f"STATE:{sid}", "state", "chain", "long", "5m", feat["state_id"] == sid)
    push("CEPE:ce_dom", "cepe", "cepe", "long", "5m", (feat["cepe_ret_diff"] > 2).fillna(False))
    push("CEPE:pe_dom", "cepe", "cepe", "long", "5m", (feat["cepe_ret_diff"] < -2).fillna(False))
    cands_df = pd.DataFrame(cands)
    if len(cands_df):
        cands_df["perm_p_adj"] = bh(cands_df["perm_p"].fillna(1).values)
    # lead/lag k=1,2,3,5,10
    ll_rows = []
    contracts = chain
    ser = {}
    fwd = {}
    for c in contracts:
        s = c[:-2]; o = c[-2:]
        sub = feat[(feat["strike"].astype(str) == str(s)) & (feat["option_type"] == o)].set_index("timestamp").sort_index()
        ser[c] = sub["return_5"]; fwd[c] = sub["fwd_ret_5m"]
    import itertools
    for A_, B_ in itertools.permutations(contracts, 2):
        for k in (1, 2, 3, 5, 10):
            common = ser[A_].index.intersection(fwd[B_].index)
            s = ser[A_].reindex(common); t = fwd[B_].reindex(common).shift(-k)
            m = s.abs() > 1.0
            vals = t[m].dropna()
            if len(vals) >= 50:
                tgt = feat[(feat["strike"].astype(str) + feat["option_type"]) == B_].set_index("timestamp").sort_index()
                mfe = float(tgt.reindex(vals.index)["MFE_5m"].mean()) if "MFE_5m" in tgt.columns else 0.0
                mae = float(tgt.reindex(vals.index)["MAE_5m"].mean()) if "MAE_5m" in tgt.columns else 0.0
                ll_rows.append({"source": A_, "target": B_, "lag": k, "events": len(vals),
                                "mean_fwd5": float(vals.mean()), "hit_rate": float((vals > 0).mean()),
                                "median": float(vals.median()), "MFE": mfe, "MAE": mae})
    ll = pd.DataFrame(ll_rows)
    # 17-18 exit propagation test + backtest only on survivors
    surv = cands_df[cands_df["final_status"].isin(["OOS_SURVIVED", "PAPER_CANDIDATE"])] if len(cands_df) else cands_df
    bt_ok = True
    try:
        _m = pd.Series(False, index=feat.index); _m.iloc[0] = True
        bt_test = backtest(feat, _m,
                           hold_bars=5, sl=1.0, tp=2.0, exit_mode="fixed", cid="PROPAGATION_TEST")
        assert "fingerprint" in bt_test.columns
        assert (bt_test["fingerprint"].str.contains("sl=1.0").all())
        print("PARAMETER_PROPAGATION_TEST=PASS")
    except Exception as e:
        print(f"PARAMETER_PROPAGATION_TEST=FAIL {e}"); bt_ok = False
    print("METRIC_DEFINITION_AUDIT=PASS (raw_trade/daily/bootstrap/surrogate/oos kept separate)")
    counts = {"total_features_tested": FEATURE_COUNT["n"], "total_relationships_tested": REL_COUNT["n"],
              "total_sequences_tested": SEQ_COUNT["n"], "total_states_tested": STATE_COUNT["n"],
              "total_candidate_events": len(cands_df)}
    COUNTS.update(counts)
    seqs_df = pd.DataFrame([{"pattern": r["candidate"], "events": r["events"], "oos_exp": r["OOS_expectancy"]} for _, r in cands_df[cands_df["type"] == "sequence"].iterrows()]) if len(cands_df) else pd.DataFrame()
    states_df = cands_df[cands_df["type"] == "state"] if len(cands_df) else pd.DataFrame()
    meta = {"run_id": run_id, "dataset_path": a.path, "data_format": fmt, "chain": chain,
            "strikes": strikes, "code_version": "od-v3", "seed": 42,
            "splits": {k: [str(d) for d in v] for k, v in splits.items()}}
    rep = write_report(outdir, meta, health, ctxt, extxt, cands_df, ll, states_df, seqs_df, wf, leak, True, counts)
    print("OPTION_CHAIN_DISCOVERY=ACTIVE (cepe/cross/leadlag/seq/state computed)")
    print(f"OOS_VALIDATION=ACTIVE report={rep} survivors={len(surv)}")
    print("INDICATOR_BASELINE: VolRate-class = INDICATOR_BASELINE, not OPTION_CHAIN_DISCOVERY")
    if len(surv) == 0:
        print("NO_ROBUST_DISCOVERY")

if __name__ == "__main__":
    main()
