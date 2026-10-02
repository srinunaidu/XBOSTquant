"""Orchestrator: implementation order §36. Run: python3 -m research.run_discovery --path 'Data test/banknifty_options.csv'"""
import argparse
import hashlib
import json
import os
import time
import uuid
import pandas as pd
import numpy as np

from .config import CONFIG
from .data_loader import load_dataset, focus_strikes, dataset_hash
from .validator import validate
from .features_raw import add_raw_features
from .features_volume import add_volume_features
from .relationships import add_cepe_crossstrike
from .events import add_events
from .sequences import add_sequences
from .labels import add_forward_labels
from .states import add_states
from .leadlag import leadlag_tests
from .validation import (chronological_splits, cluster_events, candidate_stats,
                         best_removal, permutation_pvalue, bh_correction)
from .ranking import rank_candidates
from .report import write_artifacts

CODE_VERSION = "v2.0-first-run"
FEATURE_VERSION = "raw-v1"

def evaluate_mask(feat: pd.DataFrame, mask: pd.Series, splits: dict, day_of: pd.Series, cfg) -> dict:
    vals_all = feat.loc[mask, "fwd_ret_5m"]
    days_all = day_of.loc[mask]
    out = {}
    for part, dlist in splits.items():
        m = mask & day_of.isin(pd.to_datetime(dlist).date if False else dlist)
        # day_of holds date objects; dlist holds date objects
        v = feat.loc[m, "fwd_ret_5m"]
        d = day_of.loc[m]
        cs = cluster_events(feat.loc[m, ["timestamp", "strike", "option_type"]], cfg.cluster_minutes) if m.sum() else None
        n_indep = int(cs["event_id"].nunique()) if cs is not None and len(cs) else 0
        st = candidate_stats(v, d)
        out[part] = {"stats": st, "n_indep": n_indep, "vals": v, "days": d}
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", required=True)
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    outdir = args.outdir or os.path.join("research", "runs", run_id)

    norm, fmt = load_dataset(args.path)
    dh = dataset_hash(norm)
    valid = validate(norm)
    focus = focus_strikes(norm, CONFIG.focus_strikes_n)
    focus_contracts = [s + t for s in focus for t in ["CE", "PE"]]

    # trading-day splits (by date)
    norm["day"] = pd.to_datetime(norm["timestamp"]).dt.date
    days = sorted(norm["day"].unique().tolist())
    splits = chronological_splits(days, CONFIG.split_fractions)

    # pipeline in §36 order
    feat = add_raw_features(norm, CONFIG)
    feat = add_volume_features(feat, CONFIG)
    feat = add_cepe_crossstrike(feat, focus)
    feat = add_events(feat, CONFIG)
    feat = add_sequences(feat, CONFIG)
    feat = add_forward_labels(feat, CONFIG)
    feat = add_states(feat, CONFIG)
    feat["day"] = pd.to_datetime(feat["timestamp"]).dt.date
    day_of = feat["day"]

    # --- candidate generation ---
    cand_rows = []
    tests = {"features": 0, "events": 0, "pairs": 0, "seqs": 0, "states": 0}
    event_cols = [c for c in feat.columns if c.startswith("ev_")]
    tests["events"] = len(event_cols)
    tests["features"] = len([c for c in feat.columns if c.startswith(("return_", "accel_", "vol_", "range_", "dist_"))])

    def push(cid, desc, mask):
        if mask.sum() < CONFIG.min_raw_occurrences:
            return
        # train = discovery+refinement, oos = pseudo_oos, holdout separate
        train_days = splits["discovery"] + splits["refinement"]
        m_train = mask & day_of.isin(train_days)
        m_oos = mask & day_of.isin(splits["pseudo_oos"])
        m_hold = mask & day_of.isin(splits["holdout"])
        m_all = mask
        v_all = feat.loc[m_all, "fwd_ret_5m"].dropna()
        if len(v_all) < CONFIG.min_raw_occurrences:
            return
        cs = cluster_events(feat.loc[m_all, ["timestamp", "strike", "option_type"]], CONFIG.cluster_minutes)
        n_indep = int(cs["event_id"].nunique())
        indep_days = int(day_of.loc[m_all].nunique())
        st_all = candidate_stats(v_all, day_of.loc[v_all.index])
        v_tr = feat.loc[m_train, "fwd_ret_5m"].dropna()
        v_oos = feat.loc[m_oos, "fwd_ret_5m"].dropna()
        mean_tr = float(v_tr.mean()) if len(v_tr) else float("nan")
        mean_oos = float(v_oos.mean()) if len(v_oos) else float("nan")
        br = best_removal(v_all, day_of.loc[v_all.index])
        perm = permutation_pvalue(v_all, n_perm=CONFIG.permutation_count, seed=CONFIG.random_seed)
        cand_rows.append({
            "candidate_id": cid, "description": desc,
            "n": st_all.get("n", 0), "n_indep": n_indep, "indep_days": indep_days,
            "mean_train": mean_tr, "mean_oos": mean_oos,
            "median_all": st_all.get("median", float("nan")),
            "win_rate": st_all.get("win_rate", float("nan")),
            "top1_conc": st_all.get("top1", 1), "top3_conc": st_all.get("top3", 1),
            "rm_best3": br.get("rm_best3", float("nan")), "rm_bestday1": br.get("rm_bestday1", float("nan")),
            "perm_p": perm["p"], "mfe_med": float(feat.loc[m_all, "MFE_5m"].median()),
            "mae_med": float(feat.loc[m_all, "MAE_5m"].median()),
        })

    for ec in event_cols:
        push(f"EV:{ec}", f"{ec}==1 forward 5m", feat[ec] == 1)
    # sequences: top patterns per length
    seq_rows = []
    for L in CONFIG.seq_lengths:
        col = f"seq_{L}"
        grp = feat.groupby(col)["fwd_ret_5m"].agg(["count", "mean", "median"]).reset_index()
        grp = grp[grp["count"] >= CONFIG.min_raw_occurrences].sort_values("mean", ascending=False).head(10)
        tests["seqs"] += int((feat[col].value_counts() >= CONFIG.min_raw_occurrences).sum())
        for _, r in grp.iterrows():
            push(f"SEQ:{col}={r[col]}", f"pattern {r[col]} forward 5m", feat[col] == r[col])
            seq_rows.append({"pattern": r[col], "length": L, "n": int(r["count"]),
                             "mean_fwd5": float(r["mean"]), "median_fwd5": float(r["median"])})
    seqs_df = pd.DataFrame(seq_rows)
    # states: top states
    stg = feat.groupby("state_id")["fwd_ret_5m"].agg(["count", "mean", "median"]).reset_index()
    stg["days"] = feat.groupby("state_id")["day"].nunique().values
    stg = stg[stg["count"] >= CONFIG.min_raw_occurrences].sort_values("mean", ascending=False).head(20)
    tests["states"] = int((feat["state_id"].value_counts() >= CONFIG.min_raw_occurrences).sum())
    for _, r in stg.iterrows():
        push(f"STATE:{r['state_id']}", f"state {r['state_id']} forward 5m", feat["state_id"] == r["state_id"])
    states_df = stg.rename(columns={"count": "n", "mean": "mean_fwd5", "median": "median_fwd5"})
    # CE/PE extremes
    push("CEPE:ce_lead", "cepe_ret_diff>2 forward 5m (CE)", (feat["cepe_ret_diff"] > 2).fillna(False))
    push("CEPE:pe_lead", "cepe_ret_diff<-2 forward 5m (PE)", (feat["cepe_ret_diff"] < -2).fillna(False))
    push("CEPE:simul", "simultaneous_expansion==1", (feat["simultaneous_expansion"] == 1).fillna(False))

    cands = pd.DataFrame(cand_rows)
    # multiple-testing correction over all candidates
    if len(cands):
        cands["perm_p_adj"] = bh_correction(cands["perm_p"].fillna(1).values)
        cands = rank_candidates(cands)
    # lead/lag (counts toward pair_tests)
    ll = leadlag_tests(feat, [c for c in focus_contracts
                              if ((feat["strike"].astype(str) + feat["option_type"]) == c).any()],
                       CONFIG)
    tests["pairs"] = len(ll)

    meta = {
        "run_id": run_id, "dataset_path": args.path, "data_format": fmt,
        "dataset_hash": dh, "dataset_version": "repo-csv",
        "feature_version": FEATURE_VERSION, "code_version": CODE_VERSION,
        "parameters": CONFIG.__dict__, "seed": CONFIG.random_seed,
        "train_period": f"{splits['discovery'][0]}..{splits['refinement'][-1]}" if splits["refinement"] else str(splits["discovery"]),
        "test_period": f"{splits['pseudo_oos'][0]}..{splits['holdout'][-1]}" if splits["holdout"] else "",
        "splits": {k: [str(d) for d in v] for k, v in splits.items()},
        "focus_strikes": focus, "focus_contracts": focus_contracts,
        "features_tested": tests["features"], "events_tested": tests["events"],
        "pair_tests": tests["pairs"], "seq_tests": tests["seqs"], "state_tests": tests["states"],
        "price_model": CONFIG.price_model,
    }
    rep = write_artifacts(outdir, meta, valid, cands, ll, states_df, seqs_df)
    print(f"run_id={run_id}\nformat={fmt} hash={dh}\nfocus={focus}\nreport={rep}\ncandidates={len(cands)}")
    if len(cands):
        print(cands[["candidate_id", "n", "n_indep", "indep_days", "mean_oos", "perm_p_adj", "status"]].head(10).to_string(index=False))

if __name__ == "__main__":
    main()
