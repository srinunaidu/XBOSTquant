"""Explicit 13-filter pipeline (§23). Every filter logs input/passed/rejected + reason."""
import pandas as pd


def run_filters(cands_df, min_events=50, min_oos_events=20):
    """Sequential filters F1..F13 over candidate rows. Returns (survivors, log)."""
    log = []

    def stage(name, df, keep, reason):
        passed = df[keep].copy() if len(df) else df
        log.append({"filter": name, "input_count": int(len(df)),
                    "passed_count": int(len(passed)),
                    "rejected_count": int(len(df) - len(passed)),
                    "rejection_reason": reason})
        return passed

    df = cands_df
    df = stage("F1_DATA_QUALITY", df, pd.Series(True, index=df.index),
               "invalid rows rejected at ingestion")
    df = stage("F2_LIQUIDITY", df, pd.Series(True, index=df.index),
               "min price/volume applied at feature level")
    df = stage("F3_CHAIN_QUALITY", df, pd.Series(True, index=df.index),
               "synchronized-chain completeness gate at ingestion")
    df = stage("F4_EVENT_QUALITY", df, df["events"] >= min_events,
               f"events < {min_events}")
    df = stage("F5_FORWARD_EDGE", df, df["FWD_expectancy"] > 0,
               "label expectancy <= 0")
    df = stage("F6_SAMPLE_SIZE", df, df["clusters"] >= 10,
               "independent clusters < 10")
    df = stage("F7_CLUSTER_INDEPENDENCE", df, (df["events"] / df["clusters"].clip(lower=1)) <= 20,
               ">20 events per cluster (burst artifact)")
    df = stage("F8_TRAIN_VALIDATION", df, df["FWD_IS_expectancy"] > 0,
               "train-label expectancy <= 0")
    df = stage("F9_OOS", df, (df["FWD_OOS_events"] >= min_oos_events) & (df["FWD_OOS_expectancy"] > 0),
               f"OOS events < {min_oos_events} or OOS expectancy <= 0")
    df = stage("F10_ROBUSTNESS", df, ~df["final_status"].isin(
        ["CAP_DOMINATED", "CONCENTRATED", "THIN_SAMPLE"]),
        "cap-dominated / concentrated / thin sample")
    df = stage("F11_MULTIPLE_TESTING", df, df["perm_p_adj"] < 0.10,
               "BH-adjusted surrogate p >= 0.10")
    df = stage("F12_EXECUTION", df, pd.Series(True, index=df.index),
               "RESEARCH_PRICE_MODEL only (no bid/ask); executable economics N/A")
    df = stage("F13_PAPER_GATE", df, df["final_status"].isin(["ROBUST", "OOS_SURVIVED"]),
               "paper gate: not OOS_SURVIVED/ROBUST or short-sample rule")
    return df, log
