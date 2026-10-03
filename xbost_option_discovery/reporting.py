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

def retier_from_adjusted(cands, max_padj=0.10, min_oos_events=20):
    """Recompute `final_status` / `failure_reason` from the BH-ADJUSTED p.

    The statistical tier must never be more optimistic than the
    multiple-testing gate acting on the same row: the eval-time tier uses
    the raw permutation p while F11/paper use `perm_p_adj`, so without this
    a row could read OOS_SURVIVED while rejected for data-snooping."""
    if cands is None or len(cands) == 0:
        return cands
    df = cands.copy()
    statuses, fails = [], []
    for _, r in df.iterrows():
        og = str(r.get("oos_gate", "THIN_OOS") or "THIN_OOS")
        padj = r.get("perm_p_adj", 1.0)
        try:
            padj = float(padj) if padj == padj else 1.0
        except (TypeError, ValueError):
            padj = 1.0
        st = assign_status(int(r["events"]), int(r["clusters"]), int(r.get("days", 0)),
                           int(r.get("OOS_events", 0)), r.get("FWD_OOS_expectancy", float("nan")),
                           r.get("FWD_IS_expectancy", float("nan")), padj,
                           r.get("top5", 1.0), og,
                           cap_dominated=bool(r.get("exit_cap_dominated", False)))
        if str(r.get("METRIC_INTEGRITY")) == "FAIL":
            st = "REJECTED"
        reasons = []
        if og == "THIN_OOS":
            reasons.append("THIN_OOS")
        try:
            _top5 = float(r.get("top5", 1.0) or 1.0)
        except (TypeError, ValueError):
            _top5 = 1.0
        if _top5 > 0.5:
            reasons.append("concentration")
        if not (padj < max_padj):
            reasons.append("surrogate-fail")
        if str(r.get("METRIC_INTEGRITY")) == "FAIL":
            reasons.append("metric-fail")
        if bool(r.get("exit_cap_dominated", False)):
            reasons.append("exit-cap-dominated")
        if str(r.get("OOS_result")) != "OOS_SURVIVED_MARK":
            reasons.append("OOS_REJECTED")
        statuses.append(st)
        fails.append(";".join(reasons) if reasons else "none")
    df["final_status"] = statuses
    df["failure_reason"] = fails
    return df


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
    md = meta.get("chain_metadata", {})
    A("# XBOST Option-Native Discovery — Final Report (RESEARCH_PRICE_MODEL)")
    A(f"run {meta.get('run_id')} | layout={meta.get('data_format')} | contracts={md.get('n_contracts')}")
    A("LIMITATION: short-horizon option data is sufficient for discovery and structural research, "
      "but insufficient for strong long-horizon robustness claims.")
    A("")
    disc = cands[cands["final_status"].isin(["ROBUST", "OOS_SURVIVED"])] if len(cands) else cands
    oos_ok = cands[cands["OOS_result"] == "OOS_SURVIVED_MARK"] if len(cands) and "OOS_result" in cands else cands.iloc[0:0]
    secs = [
        ("1. DATASET STRUCTURE", [f"layout={meta.get('data_format')}",
                                  f"underlying={md.get('underlying')}",
                                  f"contracts={md.get('n_contracts')} types={md.get('option_types')} "
                                  f"strikes={md.get('n_strikes')} expiries={md.get('expiries')}"] ),
        ("2. DATA HEALTH", [f"status={health.get('status')}", f"rows={health.get('rows')}",
                            f"timestamps={health.get('timestamps')} days={health.get('unique_days')} "
                            f"{health.get('date_start')}..{health.get('date_end')}",
                            f"missing={health.get('missing_interval_count')} "
                            f"dup={health.get('duplicate_timestamp_count')} "
                            f"volcov={health.get('volume_coverage')}"]),
        ("3. DISCOVERED CHAIN DIMENSIONS", [json.dumps({k: md.get(k) for k in
            ("n_contracts", "n_strikes", "n_option_types", "n_expiries",
             "synchronized_snapshots", "complete_snapshots", "completeness")})]),
        ("4. AVAILABLE DISCOVERY MODULES", [", ".join(
            f"{k}={v}" for k, v in (meta.get("modules") or {}).items()) or "(none)"]),
        ("5. SKIPPED/UNAVAILABLE MODULES", [json.dumps(meta.get("modules_unavailable") or {}) or "(none)"]),
        ("6. DISCOVERY SEARCH SPACE", [json.dumps(counts)]),
        ("7. EVENTS DISCOVERED", [f"{len(cands)} candidates across families: " +
                                  (", ".join(f"{k}={v}" for k, v in
                                   cands['discovery_family'].value_counts().items()) if len(cands) else "none")]),
        ("8. RELATIONSHIPS DISCOVERED", [f"{len(ll)} lead/lag pair-tests; "
                                         f"type/strike/breadth columns in candidates.csv"]),
        ("9. FORWARD-RETURN RESULTS (DISCOVERY, label-based)",
         [cands[["candidate", "discovery_family", "FWD_expectancy",
                 "FWD_OOS_expectancy", "perm_p", "final_status"]].head(15).to_markdown(index=False)
          if len(cands) else "(none)"]),
        ("10. TRADING CANDIDATES (path-exit, secondary)",
         [cands[["candidate", "events", "IS_expectancy", "IS_TRADE_SHARPE",
                 "exit_cap_dominated"]].head(10).to_markdown(index=False) if len(cands) else "(none)"]),
        ("11. OOS RESULTS", [f"OOS gate: THIN_OOS if oos_n<20; "
                             f"{len(oos_ok)} positive-OOS-label candidates; "
                             f"{len(disc)} DISCOVERY-or-better"]),
        ("12. WALK-FORWARD RESULTS", [pd.DataFrame(wf).to_markdown(index=False) if len(wf) else "(insufficient folds)"]),
        ("13. ROBUSTNESS RESULTS", ["time/type/strike/perturb/best-removal/concentration in candidates.csv"]),
        ("14. MULTIPLE-TESTING RESULTS", [f"BH-adjusted perm p; {json.dumps(counts)}"]),
        ("15. PAPER ELIGIBILITY", [paper_gate(cands)]),
        ("16. RESULT STRATA", [
            f"DISCOVERY RESULT: {len(cands)} candidates measured",
            f"VALIDATED RESULT: {len(disc)} surviving discovery gates",
            f"OOS RESULT: {len(oos_ok)} positive-OOS-label",
            f"PAPER-ELIGIBLE RESULT: 0 (short-sample gate)"]),
    ]
    for title, body in secs:
        A(f"## {title}")
        A("\n".join(body) if isinstance(body, list) else str(body))
        A("")
    A(f"NO_LOOKAHEAD_TEST={'PASS' if leak.get('PASS') else 'FAIL'}")
    A(f"METRIC_DEFINITION_AUDIT={'PASS' if metric_audit else 'FAIL'}")
    with open(os.path.join(outdir, "report.md"), "w") as f:
        f.write("\n".join(L))
    # dynamic dashboard: sections render from discovered metadata; unsupported
    # modules render as NOT_APPLICABLE instead of fixed strike/contract names
    html = ["<html><head><title>OPTION NATIVE DISCOVERY</title></head><body>",
            "<h1>OPTION NATIVE DISCOVERY</h1>",
            f"<p>run {meta.get('run_id')} | contracts={md.get('n_contracts')} "
            f"types={md.get('option_types')} expiries={md.get('expiries')}</p>",
            "<h2>DATA HEALTH</h2>", f"<p>{health.get('status')} "
            f"rows={health.get('rows')} snapshots={md.get('synchronized_snapshots')}</p>",
            "<h2>CHAIN STRUCTURE</h2>",
            pd.DataFrame([{"contracts": md.get("n_contracts"), "strikes": md.get("n_strikes"),
                           "types": md.get("option_types"), "expiries": md.get("expiries")}]).to_html(index=False),
            "<h2>MODULES</h2>",
            pd.DataFrame([{"module": k, "status": v}
                          for k, v in (meta.get("modules") or {}).items()]).to_html(index=False),
            "<h2>TRADING CANDIDATES</h2>",
            cands.head(20).to_html(index=False) if len(cands) else "<p>NO_VALIDATED_EDGE</p>",
            "<h2>LEAD/LAG</h2>", ll.head(20).to_html(index=False) if len(ll) else "<p>NOT_APPLICABLE</p>",
            "<h2>BASELINE INDICATOR SEARCH (comparison only)</h2><p>Not mixed with option-native discoveries.</p>",
            "</body></html>"]
    with open(os.path.join(outdir, "dashboard.html"), "w") as f:
        f.write("\n".join(html))
    return os.path.join(outdir, "report.md")
