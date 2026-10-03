"""Edge ladder (§42/§58), final status taxonomy (§2), paper gate (§56),
candidate boards (§43). No gate weakening: thresholds are constants."""

VALIDATED = "VALIDATED_EDGE_FOUND"
NO_EDGE = "NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET"
BUDGET_OUT = "SEARCH_BUDGET_EXHAUSTED"
SPACE_OUT = "SEARCH_SPACE_EXHAUSTED"
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
                 blocked_reason: str = "", search_completed: bool = False,
                 space_exhausted: bool = False) -> str:
    """Mutually exclusive final statuses (§2/§31)."""
    if engine_error:
        return ENG_ERR
    if blocked_reason:
        return BLOCKED
    if not data_ok:
        return NO_DATA
    if n_validated > 0:
        return VALIDATED
    if space_exhausted and frontier_size == 0:
        return SPACE_OUT
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
        # "where testable": single-contract data cannot generalize by
        # construction; multi-contract data must show broad support
        "CONTRACT_GENERALIZATION_PASS": (
            str(row.get("contract_status")) == "PASS" or
            (str(row.get("contract_status")) == "UNTESTABLE"
             and int(row.get("contract_count") or 0) < 2)),
        "BEST_EVENT_PASS": float(row.get("rm_best3") if row.get("rm_best3") == row.get("rm_best3") else -1) > 0,
        "CONCENTRATION_PASS": float(row.get("top5") or 1) < 0.5,
        "EXECUTION_MODEL_VALID": bool(has_bidask),
        "LOOKAHEAD_PASS": str(row.get("lookahead_pass")) == "True"
        or row.get("lookahead_pass") is True,
    }
    failed = [k for k, v in checks.items() if not v]
    if failed:
        return False, "missing: " + ",".join(failed)
    return True, "all gates pass"


# ---- continuous-loop discovery taxonomy (§20/§21) ----
# L1=INFORMATIONAL L2=PREDICTIVE L3=TRADING_RULE L4=ROBUST L5=OOS_TRADING
# L6=MULTIPLE_TESTING_SURVIVAL L7=EXECUTABLE L8=PAPER_ELIGIBLE
LADDER_L1_L8 = ("L1_INFORMATIONAL_EDGE", "L2_PREDICTIVE_EDGE",
                "L3_TRADING_RULE_EDGE", "L4_ROBUST_EDGE",
                "L5_OOS_TRADING_EDGE", "L6_MULTIPLE_TEST_SURVIVAL",
                "L7_EXECUTABLE_EDGE", "L8_PAPER_ELIGIBLE")


def discovery_category(row: dict) -> str:
    """One of INFORMATION_DISCOVERY / PREDICTIVE_DISCOVERY /
    TRADING_RULE_DISCOVERY / ROBUST_DISCOVERY / OOS_DISCOVERY /
    VALIDATED_EDGE. A discovery is never automatically a strategy."""
    def num(x):
        try:
            v = float(x)
            return v if v == v else None
        except (TypeError, ValueError):
            return None
    info = num(row.get("FWD_expectancy")) is not None \
        and num(row.get("FWD_expectancy")) > 0
    pred = info and (num(row.get("FWD_IS_expectancy")) or -1) > 0
    trade = pred and (num(row.get("IS_expectancy")) or -1) > 0
    rob = trade and (num(row.get("robustness_score")) or 0) >= 4.0
    oos = rob and str(row.get("OOS_trading_result")) == "OOS_TRADING_RULE_PASS"
    mt = oos and (str(row.get("mt_pass")) == "True"
                  or row.get("mt_pass") is True)
    if mt and str(row.get("execution_model")) == "EXECUTABLE_PRICE_MODEL" \
            and row.get("paper_eligible") is True:
        return "VALIDATED_EDGE"
    if mt or oos:
        return "OOS_DISCOVERY"
    if rob:
        return "ROBUST_DISCOVERY"
    if trade:
        return "TRADING_RULE_DISCOVERY"
    if pred:
        return "PREDICTIVE_DISCOVERY"
    if info:
        return "INFORMATION_DISCOVERY"
    return "NO_DISCOVERY"


def edge_levels_l1_l8(row: dict) -> dict:
    """Explicit §20 edge levels per candidate; never collapsed to one score."""
    cat = discovery_category(row)
    order = ("INFORMATION_DISCOVERY", "PREDICTIVE_DISCOVERY",
             "TRADING_RULE_DISCOVERY", "ROBUST_DISCOVERY", "OOS_DISCOVERY",
             "VALIDATED_EDGE")
    reached = order.index(cat) if cat in order else -1
    levels = {}
    for i, name in enumerate(LADDER_L1_L8):
        if name in ("L6_MULTIPLE_TEST_SURVIVAL",):
            on = cat in ("OOS_DISCOVERY", "VALIDATED_EDGE") and (
                str(row.get("mt_pass")) == "True"
                or row.get("mt_pass") is True)
        elif name == "L7_EXECUTABLE_EDGE":
            on = str(row.get("execution_model")) == "EXECUTABLE_PRICE_MODEL"
        elif name == "L8_PAPER_ELIGIBLE":
            on = cat == "VALIDATED_EDGE"
        else:
            rank = {"L1_INFORMATIONAL_EDGE": 0, "L2_PREDICTIVE_EDGE": 1,
                    "L3_TRADING_RULE_EDGE": 2, "L4_ROBUST_EDGE": 3,
                    "L5_OOS_TRADING_EDGE": 4}[name]
            on = reached >= rank
        levels[name] = bool(on)
    return {"levels": levels, "category": cat}


def oos_stage(expectancy, n_events, min_oos_events, mt_pass,
              robust_pass=False) -> str:
    """§24: OOS_TESTED → OOS_RAW_POSITIVE → OOS_THRESHOLD_PASS →
    OOS_ROBUST_PASS → OOS_MULTIPLE_TEST_PASS → OOS_FINAL_SURVIVOR.
    Positive OOS is never reported as validated."""
    try:
        e = float(expectancy)
    except (TypeError, ValueError):
        return "OOS_FAIL"
    if not (e == e and e > 0):
        return "OOS_FAIL"
    if int(n_events or 0) < int(min_oos_events):
        return "OOS_RAW_POSITIVE"
    if not robust_pass:
        return "OOS_THRESHOLD_PASS"
    if not (str(mt_pass) == "True" or mt_pass is True):
        return "OOS_ROBUST_PASS"
    return "OOS_MULTIPLE_TEST_PASS"


def oos_final_survivor(oos_stage_value, paper_checks_pass: bool) -> str:
    if oos_stage_value == "OOS_MULTIPLE_TEST_PASS" and paper_checks_pass:
        return "OOS_FINAL_SURVIVOR"
    return oos_stage_value


# ---- §25 edge validation ladder L1-L10 ----
LADDER_L1_L10 = ("L1_DATA_VALID", "L2_ENTRY_SIGNAL", "L3_RETURN_PATH",
                 "L4_EXIT_FOUND", "L5_OOS", "L6_ROBUSTNESS",
                 "L7_MULTIPLE_TESTING", "L8_EXECUTION", "L9_PAPER_READY",
                 "L10_VALIDATED_EDGE")


def _num(x):
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def ladder_l1_l10(row: dict) -> dict:
    """Every candidate moves through L1-L10; failing level routes back to
    the appropriate queue (L4 fail → exit queue, never discard)."""
    l1 = str(row.get("final_status")) not in ("THIN_SAMPLE", "DATA_INVALID")
    l2 = (_num(row.get("FWD_IS_expectancy")) or -1) > 0
    l3 = str(row.get("return_path_class", "")) not in ("", "NOISE", "NA", "None")
    l4 = str(row.get("exit_discovery_status", "")) in (
        "DISCOVERED", "PRESCRIBED_VARIANT", "EXIT_DISCOVERY_RAN_NO_IMPROVEMENT")
    l5 = str(row.get("OOS_trading_result")) == "OOS_TRADING_RULE_PASS"
    l6 = (_num(row.get("robustness_score")) or 0) >= 4.0
    l7 = str(row.get("mt_pass")) == "True" or row.get("mt_pass") is True
    l8 = str(row.get("execution_model")) == "EXECUTABLE_PRICE_MODEL"
    l9 = row.get("paper_eligible") is True
    l10 = bool(l9 and l8)
    levels = {"L1_DATA_VALID": l1, "L2_ENTRY_SIGNAL": l2,
              "L3_RETURN_PATH": l3, "L4_EXIT_FOUND": l4, "L5_OOS": l5,
              "L6_ROBUSTNESS": l6, "L7_MULTIPLE_TESTING": l7,
              "L8_EXECUTION": l8, "L9_PAPER_READY": l9,
              "L10_VALIDATED_EDGE": l10}
    failed = next((k for k, v in levels.items() if not v), None)
    return {"levels": levels, "failed_at": failed or "NONE_ALL_PASS"}


def frontier_bucket(row: dict) -> str:
    """§20 live-frontier states: validated > unresolved exits >
    promising OOS > robust > promising entry."""
    cat = str(row.get("discovery_category", ""))
    if cat == "VALIDATED_EDGE":
        return "VALIDATED_EDGE"
    if str(row.get("unresolved_code", "")) in (
            "ENTRY_PROMISING_EXIT_UNRESOLVED",
            "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED"):
        return "PROMISING_ENTRY_EXIT_UNRESOLVED"
    if cat == "OOS_DISCOVERY":
        return "PROMISING_OOS"
    if cat == "ROBUST_DISCOVERY":
        return "ROBUST_CANDIDATE"
    if cat in ("TRADING_RULE_DISCOVERY", "PREDICTIVE_DISCOVERY",
               "INFORMATION_DISCOVERY"):
        return "PROMISING_ENTRY"
    return "NO_FRONTIER"


def final_research_state(category: str, mt_pass, exec_ok: bool,
                         unresolved_code: str, oos_trading: str,
                         robust_ok: bool) -> str:
    """Post-search research state (§1) from validated gates."""
    mt = str(mt_pass) == "True" or mt_pass is True
    if category == "VALIDATED_EDGE":
        return "VALIDATED_EDGE"
    if category == "OOS_DISCOVERY":
        if not mt:
            return "MULTIPLE_TESTING_FAILED"
        if not exec_ok:
            return "EXECUTION_FAILED"
        return "SIGNAL_FOUND_EXIT_FOUND"
    if category == "ROBUST_DISCOVERY":
        return "OOS_FAILED"
    if category == "TRADING_RULE_DISCOVERY":
        if oos_trading == "OOS_TRADING_RULE_PASS":
            return "MULTIPLE_TESTING_FAILED" if not mt else "SIGNAL_FOUND_EXIT_FOUND"
        return "OOS_FAILED"
    if category == "PREDICTIVE_DISCOVERY":
        if unresolved_code in ("ENTRY_PROMISING_EXIT_UNRESOLVED",
                               "PREDICTIVE_BUT_TRADING_RULE_UNRESOLVED"):
            return "SIGNAL_FOUND_EXIT_UNRESOLVED"
        return "OOS_FAILED"
    return "NO_SIGNAL_FOUND"
