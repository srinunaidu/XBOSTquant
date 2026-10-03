"""Research-state taxonomy (§1): every research attempt is classified.
Only VALIDATED_EDGE / SEARCH_SPACE_EXHAUSTED / BUDGET_EXHAUSTED /
DATA_BLOCKED / ENGINE_ERROR are terminal. Everything else feeds the
adaptive controller — failure of a method is never failure of discovery.
"""
ENGINE_ERROR = "ENGINE_ERROR"
DATA_IDENTITY_ERROR = "DATA_IDENTITY_ERROR"
NO_MATCHING_ROWS = "NO_MATCHING_ROWS"
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
INSUFFICIENT_VARIATION = "INSUFFICIENT_VARIATION"
UNSUPPORTED_METHOD = "UNSUPPORTED_METHOD"
NO_SIGNAL_FOUND = "NO_SIGNAL_FOUND"
SIGNAL_FOUND_EXIT_UNRESOLVED = "SIGNAL_FOUND_EXIT_UNRESOLVED"
SIGNAL_FOUND_EXIT_FOUND = "SIGNAL_FOUND_EXIT_FOUND"
OOS_FAILED = "OOS_FAILED"
ROBUSTNESS_FAILED = "ROBUSTNESS_FAILED"
MULTIPLE_TESTING_FAILED = "MULTIPLE_TESTING_FAILED"
EXECUTION_FAILED = "EXECUTION_FAILED"
VALIDATED_EDGE = "VALIDATED_EDGE"
SEARCH_SPACE_EXHAUSTED = "SEARCH_SPACE_EXHAUSTED"
BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"
DATA_BLOCKED = "DATA_BLOCKED"

TERMINAL = frozenset({VALIDATED_EDGE, SEARCH_SPACE_EXHAUSTED,
                      BUDGET_EXHAUSTED, DATA_BLOCKED, ENGINE_ERROR})


def classify_candidate(info_pos, trad_pos, oos_pass, robust_pass, mt_pass,
                       exec_ok, exit_unresolved) -> str:
    """Candidate-level research state from gate outcomes."""
    if not info_pos:
        return NO_SIGNAL_FOUND
    if exit_unresolved:
        return SIGNAL_FOUND_EXIT_UNRESOLVED
    if not trad_pos:
        return NO_SIGNAL_FOUND
    if not oos_pass:
        return OOS_FAILED
    if not robust_pass:
        return ROBUSTNESS_FAILED
    if not mt_pass:
        return MULTIPLE_TESTING_FAILED
    if not exec_ok:
        return EXECUTION_FAILED
    return VALIDATED_EDGE


def classify_method(n_rows, min_rows, supported, variation_ok) -> str:
    """Method-level outcome before signal assessment."""
    if not supported:
        return UNSUPPORTED_METHOD
    if n_rows == 0:
        return NO_MATCHING_ROWS
    if n_rows < min_rows:
        return INSUFFICIENT_DATA
    if not variation_ok:
        return INSUFFICIENT_VARIATION
    return SIGNAL_FOUND_EXIT_FOUND  # placeholder: caller refines to signal/no-signal
