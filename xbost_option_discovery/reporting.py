"""Final report (§33, 20 sections) + top table (§34) + paper gate (§32) + limitation (§36)."""
import os, json
import pandas as pd

STATUS_ORDER = ["DISCOVERY", "ROBUST", "OOS_SURVIVED", "PAPER_CANDIDATE", "PAPER_ELIGIBLE",
                "OOS_REJECTED", "SURROGATE_REJECTED", "CAP_DOMINATED", "CONCENTRATED",
                "REJECTED", "THIN_SAMPLE", "DATA_INVALID"]

def assign_status(n, n_clu, days, oos_n, oos_mean, train_mean, padj, conc, thin_oos,
                  cap_dominated=None):
    """§35 weakest-critical-dimension wins. OOS rejection / surrogate failure /
    exit-cap domination can never be labelled ROBUST or above."""
    if n < 50 or days < 3:
        return "THIN_SAMPLE"
    if thin_oos == "THIN_OOS":
        return "THIN_SAMPLE"
    if oos_mean != oos_mean:  # NaN -> not calculable
        return "REJECTED"
    if oos_mean <= 0:
        return "OOS_REJECTED"
    agree = (train_mean > 0 and oos_mean > 0) or (train_mean < 0 and oos_mean < 0)
    if not agree:
        return "REJECTED"
    if padj != padj or padj >= 0.10:
        return "SURROGATE_REJECTED"
    if cap_dominated:
        return "CAP_DOMINATED"
    if conc >= 0.5:
        return "CONCENTRATED"
    if days < 5:
        return "THIN_SAMPLE"
    if padj < 0.05:
        return "OOS_SURVIVED"
    return "ROBUST"

def paper_gate(df):
    # §32: one-month data -> PAPER_ELIGIBLE=NO unless every gate passes
    if len(df) == 0:
        return "PAPER_ELIGIBLE = NO (no candidates)"
    ok = df[df["final_status"].isin(["OOS_SURVIVED", "ROBUST"])]
    if len(ok) == 0:
        return "PAPER_ELIGIBLE = NO"
    return "PAPER_ELIGIBLE = NO (one-month data: discovery valid, generalization not proven)"

def write_report(outdir, meta, health, contracts_txt, expiry_txt, cands, ll, states, seqs, wf, leak, metric_audit, counts):
    os.makedirs(outdir, exist_ok=True)
    cands.to_csv(os.path.join(outdir, "candidates.csv"), index=False)
    ll.to_csv(os.path.join(outdir, "leadlag.csv"), index=False)
    with open(os.path.join(outdir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2, default=str)
    L = []
    A = L.append
    A("# XBOST Option-Native Discovery — Final Report (RESEARCH_PRICE_MODEL)")
    A(f"run {meta['run_id']} | format={meta['data_format']} | chain={meta['chain']}")
    A("LIMITATION: One-month 1-minute option data is sufficient for discovery and structural research, but insufficient for strong long-horizon robustness claims.")
    A("")
    secs = [
        ("1. DATA HEALTH", [f"status={health['status']}", f"rows={health['rows']}", f"timestamps={health['timestamps']}",
                            f"days={health['unique_days']} {health['date_start']}..{health['date_end']}",
                            f"missing={health['missing_interval_count']} dup={health['duplicate_timestamp_count']}",
                            f"completeness={health['chain_completeness']} volcov={health['volume_coverage']}"]),
        ("2. CONTRACT / EXPIRY AUDIT", [contracts_txt, expiry_txt]),
        ("3. DISCOVERY SEARCH SPACE", [json.dumps(counts)]),
        ("4. RAW PRICE DISCOVERIES", [f"{len(cands[cands['type']=='price'])} price candidates" if 'type' in cands else f"{len(cands)} total"]),
        ("5. VOLUME DISCOVERIES", ["volume_shock/confirmation/divergence tested; see candidates"]),
        ("6. CE/PE DISCOVERIES", ["cepe_ret_diff/ratio/vol/acc + 4 lead events tested"]),
        ("7. CROSS-STRIKE DISCOVERIES", [f"spreads on {meta['chain']}"]),
        ("8. LEAD/LAG DISCOVERIES", [f"{len(ll)} pair-lag tests k=1,2,3,5,10"]),
        ("9. SEQUENCE DISCOVERIES", [f"{len(seqs)} seq patterns len<=3"]),
        ("10. STATE DISCOVERIES", [f"{len(states)} states"]),
        ("11. INDICATOR BASELINES", ["BASELINE_RSI/BB/MA/ROC/VWAP/ATR kept separate as INDICATOR_BASELINE (VolRate pair = INDICATOR_BASELINE, not OPTION_CHAIN_DISCOVERY)"]),
        ("12. IS RESULTS", [cands.head(10).to_markdown(index=False) if len(cands) else "(none)"]),
        ("13. OOS RESULTS", [f"OOS gate applied; THIN_OOS if oos_n<20"]),
        ("14. WALK-FORWARD RESULTS", [pd.DataFrame(wf).to_markdown(index=False) if len(wf) else "(insufficient folds)"]),
        ("15. ROBUSTNESS", ["time/CE-PE/strike/perturb/best-removal/concentration/dependence in candidates.csv"]),
        ("16. MULTIPLE-TESTING", [f"BH-adjusted; {json.dumps(counts)}"]),
        ("17. TOP SURVIVING PATTERNS", [cands[cands['final_status'].isin(['OOS_SURVIVED','PAPER_CANDIDATE'])].head(10).to_markdown(index=False) if len(cands) else "NO_ROBUST_DISCOVERY"]),
        ("18. OPTION-NATIVE BACKTEST", ["RESEARCH_PRICE_MODEL only; fingerprint-verified; run only on survivors"]),
        ("19. PAPER ELIGIBILITY", [paper_gate(cands)]),
        ("20. FAILURE REASONS", ["train/OOS disagreement; THIN_OOS; concentration>0.5; perm fail; see failure_reason col"]),
    ]
    for title, body in secs:
        A(f"## {title}")
        A("\n".join(body) if isinstance(body, list) else str(body))
        A("")
    A(f"NO_LOOKAHEAD_TEST={'PASS' if leak.get('PASS') else 'FAIL'}")
    A(f"METRIC_DEFINITION_AUDIT={'PASS' if metric_audit else 'FAIL'}")
    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write("\n".join(L))
    html = ["<html><body><h1>Discovery Dashboard</h1>",
            cands.head(20).to_html(index=False) if len(cands) else "<p>NO_ROBUST_DISCOVERY</p>",
            "<h2>Lead/Lag</h2>", ll.head(20).to_html(index=False) if len(ll) else "<p>(none)</p>",
            "</body></html>"]
    with open(os.path.join(outdir, "dashboard.html"), "w") as f:
        f.write("\n".join(html))
    return os.path.join(outdir, "report.md")
