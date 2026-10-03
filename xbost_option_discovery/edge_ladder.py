"""Edge ladder (§42/§58), final status taxonomy (§2), paper gate (§56),
candidate boards (§43). No gate weakening: thresholds are constants."""

VALIDATED = "VALIDATED_EDGE_FOUND"
NO_EDGE = "NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET"
BUDGET_OUT = "SEARCH_BUDGET_EXHAUSTED"
NO_DATA = "INSUFFICIENT_DATA"
ENG_ERR = "ENGINE_ERROR"
BLOCKED = "BLOCKED"

LADDER = ("L1_FEATURE_INFORMATION", "L2_EVENT_INFORMATION",
          "L3_COMBINATION_INFORMATION", "L4_RETURN_PREDICTION",
          "L5_TRADING_RULE", "L6_ROBUSTNESS", "L7_OOS", "L8_EXECUTION")


def edge_ladder(row: dict) -> dict:
    """State where the edge disappears (§42). PREDICTIVE_INFORMATION_ONLY when
    L1-L4 pass but L5 fails."""
    def num(x):
        try:
            v = float(x)
            return v if v == v else None
        except (TypeError, ValueError):
            return None
    l1 = num(row.get("FWD_expectancy")) is not None and num(row.get("FWD_expectancy")) > 0
    l2 = l1 and int(row.get("events", 0) or 0) >= 50
    l3 = l2  # combination depth recorded separately; info gate same
    l4 = l3 and (num(row.get("FWD_IS_expectancy")) or -1) > 0
    l5 = l4 and (num(row.get("IS_expectancy")) or -1) > 0 \
        and str(row.get("exit_cap_dominated")).lower() != "true"
    l6 = l5 and (num(row.get("robustness_score")) or 0) >= 4.0
    l7 = l6 and str(row.get("OOS_trading_result")) == "OOS_TRADING_RULE_PASS"
    l8 = l7 and str(row.get("execution_model")) == "EXECUTABLE_PRICE_MODEL"
    stages = {"L1_FEATURE_INFORMATION": l1, "L2_EVENT_INFORMATION": l2,
              "L3_COMBINATION_INFORMATION": l3, "L4_RETURN_PREDICTION": l4,
              "L5_TRADING_RULE": l5, "L6_ROBUSTNESS": l6, "L7_OOS": l7,
              "L8_EXECUTION": l8}
    fail_at = next((k for k, v in stages.items() if not v), None)
    kind = "NO_INFORMATION"
    if l8:
        kind = "EXECUTABLE_EDGE"
    elif l7:
        kind = "VALIDATED_OOS_EDGE"
    elif l6:
        kind = "ROBUST_EDGE_FOUND"
    elif l5:
        kind = "TRADING_EDGE_FOUND"
    elif l1:
        kind = "PREDICTIVE_INFORMATION_FOUND"
    if l4 and not l5:
        kind = "PREDICTIVE_INFORMATION_ONLY"
    return {"ladder": stages, "fails_at": fail_at or "NONE_ALL_PASS",
            "edge_kind": kind}


def final_status(n_validated: int, converged: bool, frontier_size: int,
                 budget_hit: bool, data_ok: bool, engine_error: str = "",
                 blocked_reason: str = "", search_completed: bool = False) -> str:
    """Mutually exclusive final statuses (§2)."""
    if engine_error:
        return ENG_ERR
    if blocked_reason:
        return BLOCKED
    if not data_ok:
        return NO_DATA
    if n_validated > 0:
        return VALIDATED
    if converged and frontier_size == 0:
        return NO_EDGE
    if search_completed and frontier_size == 0:
        # natural exhaustion: nothing left to test; not a budget cutoff
        return NO_EDGE
    if budget_hit and (frontier_size > 0 or not converged):
        return BUDGET_OUT
    if converged and frontier_size == 0:
        return NO_EDGE
    return BUDGET_OUT


def paper_eligible(row: dict, has_bidask: bool) -> tuple:
    """§56 paper gate. Returns (eligible_bool, reason)."""
    checks = {
        "DATA_VALID": str(row.get("final_status")) not in ("THIN_SAMPLE", "DATA_INVALID"),
        "TRADING_RULE_VALID": (row.get("edge_kind") not in (
            "PREDICTIVE_INFORMATION_ONLY", "PREDICTIVE_INFORMATION_FOUND",
            "NO_INFORMATION", None)),
        "ROBUSTNESS_PASS": float(row.get("robustness_score") or 0) >= 4.0,
        "OOS_TRADING_PASS": str(row.get("OOS_trading_result")) == "OOS_TRADING_RULE_PASS",
        "MULTIPLE_TESTING_PASS": str(row.get("mt_pass")) == "True"
        or row.get("mt_pass") is True,
        "CONTRACT_GENERALIZATION_PASS": str(row.get("contract_status")) == "PASS",
        "BEST_EVENT_PASS": float(row.get("rm_best3") if row.get("rm_best3") == row.get("rm_best3") else -1) > 0,
        "CONCENTRATION_PASS": float(row.get("top5") or 1) < 0.5,
        "EXECUTION_MODEL_VALID": bool(has_bidask),
    }
    failed = [k for k, v in checks.items() if not v]
    if failed:
        return False, "missing: " + ",".join(failed)
    return True, "all gates pass"
