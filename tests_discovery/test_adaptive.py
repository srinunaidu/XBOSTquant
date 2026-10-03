"""Adaptive-controller regression tests (§28): method failure routing,
fallback selection, exit queue, non-termination on NO_SIGNAL."""
import pandas as pd
import numpy as np

from xbost_option_discovery.search import (
    MethodMemory, next_fallback, HypothesisRegistry, FrontierQueue)
from xbost_option_discovery.research_state import (
    classify_method, classify_candidate, TERMINAL,
    NO_MATCHING_ROWS, INSUFFICIENT_DATA, UNSUPPORTED_METHOD, ENGINE_ERROR,
    NO_SIGNAL_FOUND, SIGNAL_FOUND_EXIT_UNRESOLVED, VALIDATED_EDGE)
from xbost_option_discovery.capability import horizon_eligibility
from xbost_option_discovery.edge_ladder import frontier_bucket


def test_zero_match_is_state_not_error():
    assert classify_method(0, 50, True, True) == NO_MATCHING_ROWS
    assert NO_MATCHING_ROWS not in TERMINAL


def test_insufficient_is_state_not_error():
    assert classify_method(10, 50, True, True) == INSUFFICIENT_DATA
    assert INSUFFICIENT_DATA not in TERMINAL


def test_unsupported_is_state_not_error():
    assert classify_method(100, 50, False, True) == UNSUPPORTED_METHOD
    assert UNSUPPORTED_METHOD not in TERMINAL


def test_no_signal_does_not_terminate():
    assert classify_candidate(False, False, False, False, False,
                              False, False) == NO_SIGNAL_FOUND
    assert NO_SIGNAL_FOUND not in TERMINAL


def test_failed_method_reroutes_to_alternative():
    tried = {"cross_expiry"}
    nxt = next_fallback("cross_expiry", tried)
    assert nxt == "same_expiry"  # relaxes instead of repeating impossibility
    tried.add(nxt)
    assert next_fallback(nxt, tried) == "same_strike_cepe"


def test_method_memory_learns_from_failure():
    mm = MethodMemory()
    for _ in range(5):
        mm.record("cross_expiry_relationship", 0, 0.0,
                  failure_state=NO_MATCHING_ROWS,
                  reason="NO_EXPIRY_OVERLAP")
    mm.record("momentum", 300, 0.6, found_signal=True)
    assert mm.priority("cross_expiry_relationship") < mm.priority("momentum")
    # exit-unresolved method keeps exit priority via its own record
    mm.record("momentum:exit", 300, 0.5, found_signal=False,
              failure_state=SIGNAL_FOUND_EXIT_UNRESOLVED)
    assert mm.methods["momentum:exit"]["failure_state"] == \
        SIGNAL_FOUND_EXIT_UNRESOLVED


def test_promising_entry_reaches_exit_queue():
    row = {"discovery_category": "PREDICTIVE_DISCOVERY",
           "unresolved_code": "ENTRY_PROMISING_EXIT_UNRESOLVED"}
    assert frontier_bucket(row) == "PROMISING_ENTRY_EXIT_UNRESOLVED"
    assert classify_candidate(True, False, False, False, False, False,
                              True) == SIGNAL_FOUND_EXIT_UNRESOLVED


def test_horizon_insufficient_never_padded():
    feat = pd.DataFrame({
        "fwd_ret_1m": np.random.default_rng(0).normal(0, 1, 100),
        "fwd_ret_30m": [np.nan] * 90 + list(np.random.default_rng(1).normal(0, 1, 10)),
    })
    mask = pd.Series(True, index=feat.index)
    h = horizon_eligibility(feat, mask, (1, 30), min_events=50)
    assert h[1]["status"] == "AVAILABLE"
    assert h[30]["status"] == "INSUFFICIENT"
    assert h[30]["eligible_events"] == 10  # no fabrication


def test_hypothesis_ids_never_reused_and_clones_flagged():
    r = HypothesisRegistry()
    a = r.register("ATOMIC", "SEQ", "s1")
    b = r.register("ATOMIC", "SEQ", "s1")
    assert b["duplicate"] and a["hypothesis_id"] == "H000001"
    c = r.register("ATOMIC", "SEQ", "s2")
    assert c["hypothesis_id"] == "H000002"
    assert r.global_test_count == 0
    r.count_test(3)
    assert r.global_test_count == 3  # monotonic, never reset


def test_engine_error_is_terminal_and_distinct():
    assert ENGINE_ERROR in TERMINAL
    assert VALIDATED_EDGE in TERMINAL
