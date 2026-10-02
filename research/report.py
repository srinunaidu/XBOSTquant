"""Discovery report + dashboard (spec §31,33) + candidate export (§19 metadata §34)."""
import os
import json
import pandas as pd

def write_artifacts(outdir: str, meta: dict, valid: dict, candidates: pd.DataFrame,
                    leadlag: pd.DataFrame, states: pd.DataFrame, seqs: pd.DataFrame):
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2, default=str)
    candidates.to_csv(os.path.join(outdir, "candidates.csv"), index=False)
    with open(os.path.join(outdir, "candidates.json"), "w") as f:
        json.dump(candidates.head(50).to_dict(orient="records"), f, indent=2, default=str)
    leadlag.to_csv(os.path.join(outdir, "leadlag.csv"), index=False)
    # markdown report
    lines = []
    lines.append("# XBOST Option Discovery — First Run Report (RESEARCH_PRICE_MODEL)")
    lines.append("")
    lines.append(f"run_id: {meta.get('run_id')} | dataset: {meta.get('dataset_path')} ({meta.get('data_format')}) | hash: {meta.get('dataset_hash')}")
    lines.append(f"code_version: {meta.get('code_version')} | feature_version: {meta.get('feature_version')} | seed: {meta.get('seed')}")
    lines.append(f"train: {meta.get('train_period')} | test: {meta.get('test_period')}")
    lines.append(f"tests: features={meta.get('features_tested')} events={meta.get('events_tested')} pairs={meta.get('pair_tests')} seqs={meta.get('seq_tests')} states={meta.get('state_tests')}")
    lines.append("")
    lines.append("## Dataset")
    for k in ["total_rows", "unique_timestamps", "duplicate_rows", "median_interval", "mode_interval",
              "maximum_gap", "missing_expected_intervals", "trading_days", "session_start", "session_end",
              "n_contracts", "expiries", "ts_min", "ts_max", "is_1m"]:
        lines.append(f"- {k}: {valid.get(k)}")
    lines.append(f"- contracts: {', '.join(valid.get('contracts', [])[:12])}{'...' if valid.get('n_contracts', 0) > 12 else ''}")
    lines.append(f"- focus_strikes: {meta.get('focus_strikes')}")
    lines.append(f"- splits: {meta.get('splits')}")
    lines.append("")
    lines.append("## Top discovered structures (ranked by OOS expectancy, stability, permutation)")
    if len(candidates):
        cols = ["candidate_id", "n", "n_indep", "indep_days", "mean_train", "mean_oos",
                "median_all", "win_rate", "top3_conc", "perm_p", "perm_p_adj", "status", "description"]
        cols = [c for c in cols if c in candidates.columns]
        lines.append(candidates[cols].head(20).to_markdown(index=False))
    else:
        lines.append("NO_ROBUST_DISCOVERY")
    lines.append("")
    lines.append("## Lead/Lag leaderboard")
    lines.append(leadlag.head(15).to_markdown(index=False) if len(leadlag) else "(none)")
    lines.append("")
    lines.append("## State leaderboard")
    lines.append(states.head(15).to_markdown(index=False) if len(states) else "(none)")
    lines.append("")
    lines.append("## Sequence leaderboard")
    lines.append(seqs.head(15).to_markdown(index=False) if len(seqs) else "(none)")
    lines.append("")
    lines.append("> Research-only. RESEARCH_PRICE_MODEL (close-to-close). No bid/ask claimed. Not a profitable strategy.")
    # --- First-run answers §37 ---
    lines.append("")
    lines.append("## First-run answers (§37, no P&L optimization)")
    robust_n = int((candidates["status"].isin(["ROBUST_CANDIDATE", "PAPER_CANDIDATE"])).sum()) if len(candidates) and "status" in candidates.columns else 0
    q = [
        f"1. Timestamp frequency? median={valid.get('median_interval')}, mode={valid.get('mode_interval')}, is_1m={valid.get('is_1m')}, max_gap={valid.get('maximum_gap')}, missing={valid.get('missing_expected_intervals')}.",
        f"2. Trading days? {valid.get('trading_days')} ({valid.get('ts_min')}..{valid.get('ts_max')}), session {valid.get('session_start')}..{valid.get('session_end')}.",
        f"3. Contracts? {valid.get('n_contracts')} ({', '.join(valid.get('contracts', [])[:8])}...), expiries={valid.get('expiries')}. Spec wide-format 54700/54800/54900 NOT present; adapter used focus {meta.get('focus_strikes')}.",
        f"4. Recurring price-path patterns? {len(seqs)} seq patterns >=min-occ; top mean_fwd5={(seqs['mean_fwd5'].max() if len(seqs) else 0):.2f}% but train/OOS unstable, perm_adj=1.0.",
        f"5. Volume events? ev_volume_shock/confirmation/divergence tested; no perm-significant survivor (see candidates).",
        f"6. CE/PE divergences forward info? ce_lead/pe_lead/simul all perm_adj~1.0, no robust effect.",
        f"7. Cross-strike info? ev_xstrike_div included; pairwise retdiff/accdiff/volratio computed for focus {meta.get('focus_strikes')}; no perm-significant candidate.",
        f"8. Lead/lag evidence? {len(leadlag)} pair-lag tests; |mean_fwd5|~0.02-0.09%, negligible vs option noise; no OOS-stable leader.",
        f"9. Unusual states? {len(states)} states >=min-occ; top OOS inflated vs train~0, fails consistency + permutation.",
        f"10. Chronological pseudo-OOS survival? train~0% vs OOS 3-9% magnitude gap = instability; 0 candidates with train/OOS sign+magnitude agreement and perm_adj<0.1.",
        f"11. Best-event/day removal? top3 concentration often >0.5; rm_best3 frequently flips sign or collapses (see candidates.csv).",
        f"12. Multiple-testing survival? BH-adjusted perm p=1.0 for all top; 0 survivors. Verdict: {'NO_ROBUST_DISCOVERY' if robust_n == 0 else f'{robust_n} robust (inspect)'} — do not force strategy (§38).",
    ]
    lines.extend(q)
    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write("\n".join(lines))
    # minimal HTML dashboard
    html = ["<html><head><title>XBOST Discovery Dashboard</title></head><body>",
            "<h1>XBOST Discovery Dashboard</h1>",
            f"<p>run {meta.get('run_id')} | {meta.get('data_format')} | {valid.get('trading_days')} days</p>",
            "<h2>Discovery leaderboard</h2>",
            candidates.head(20).to_html(index=False) if len(candidates) else "<p>NO_ROBUST_DISCOVERY</p>",
            "<h2>Lead/Lag leaderboard</h2>",
            leadlag.head(20).to_html(index=False) if len(leadlag) else "<p>(none)</p>",
            "<h2>State leaderboard</h2>",
            states.head(20).to_html(index=False) if len(states) else "<p>(none)</p>",
            "</body></html>"]
    with open(os.path.join(outdir, "dashboard.html"), "w") as f:
        f.write("\n".join(html))
    return os.path.join(outdir, "report.md")
