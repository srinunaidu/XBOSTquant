"""Tests for the Buy Only audit log and the UI bundle.

The log is the review artefact, so the properties that matter are: it is written
to every sink, it survives a `nan`, it is bounded in memory, it records the kinds
a reviewer needs, and it never invents a value.
"""
import json
import os

import numpy as np
import pandas as pd
import pytest

from xbost_option_discovery.buyonly.audit import RunLogger, LEVELS
from xbost_option_discovery.buyonly.bundle import build_bundle, _clean
from xbost_option_discovery.buyonly import BuyOnlySettings, summarize, by_hypothesis


# ------------------------------------------------------------------ logger

def test_logger_writes_to_text_and_jsonl_sinks(tmp_path):
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.run("configuration", lots=5, be=2.5)
    log.data("ingested", rows=10)
    log.trade("closed", net=1.5)
    assert (tmp_path / "run_log.txt").exists()
    assert (tmp_path / "audit.jsonl").exists()
    txt = (tmp_path / "run_log.txt").read_text()
    assert "configuration" in txt and "ingested" in txt and "closed" in txt
    kinds = [json.loads(l)["kind"] for l in (tmp_path / "audit.jsonl").read_text().splitlines()]
    assert kinds == ["RUN", "DATA", "TRADE"]


def test_logger_retains_lines_for_the_ui_bundle(tmp_path):
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.gate("blocked: CHOPPY_REGIME", ts="2026-01-05 09:15:00")
    assert len(log.lines) == 1
    assert "CHOPPY_REGIME" in log.lines[0]
    assert log.counts["GATE"] == 1
    assert log.summary_counts() == {"GATE": 1}


def test_logger_survives_unserialisable_and_nan_values(tmp_path):
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.stat("nan and weird", a=float("nan"), b={"nested": [1, 2]}, c=object())
    rec = json.loads((tmp_path / "audit.jsonl").read_text().splitlines()[0])
    assert rec["kind"] == "STAT"
    assert "a" in rec["fields"]      # json.dumps(default=str) must not raise


def test_logger_verbosity_levels_gate_output(tmp_path):
    quiet = RunLogger(outdir=str(tmp_path / "q"), level="quiet", echo=False)
    quiet.run("visible?")
    assert quiet.lines == []

    info = RunLogger(outdir=str(tmp_path / "i"), level="info", echo=False)
    info.at(2, "SIGNAL", "debug only")
    assert info.lines == []          # level 2 needs --log-level debug

    dbg = RunLogger(outdir=str(tmp_path / "d"), level="debug", echo=False)
    dbg.at(2, "SIGNAL", "debug only")
    assert len(dbg.lines) == 1

    assert LEVELS["trace"] > LEVELS["debug"] > LEVELS["info"] > LEVELS["quiet"]


def test_logger_bounds_retained_memory_on_huge_runs(tmp_path):
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.file_handle = None
    for i in range(26000):
        log.event("GATE", f"line {i}")
    assert len(log.lines) <= 20000, "log retention must stay bounded"
    assert log.counts["GATE"] == 26000


def test_logger_rule_emits_a_separator(tmp_path):
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.rule("SECTION")
    assert "SECTION" in log.lines[0]


# ------------------------------------------------------------------ bundle

def _mini_bundle(tmp_path, n=6):
    cfg = BuyOnlySettings()
    ledger = pd.DataFrame([{
        "trade_id": i + 1,
        "timestamp": pd.Timestamp("2026-01-05 09:15") + pd.Timedelta(minutes=i),
        "entry_time": pd.Timestamp("2026-01-05 09:16") + pd.Timedelta(minutes=i),
        "exit_time": pd.Timestamp("2026-01-05 09:20") + pd.Timedelta(minutes=i),
        "hypothesis": "VOLATILITY_COIL", "regime": "COMPRESSING",
        "direction": "CE", "symbol": "X55100CE", "strike": 55100.0,
        "expiry": "E", "moneyness": "ITM", "entry_price": 100.0 + i,
        "exit_price": 101.0 + i, "exit_reason": "TARGET", "duration_bars": 4,
        "gross_points": 1.0, "cost_points": 0.5, "net_points": 0.5, "net_pct": 0.5,
        "risk_points": 30.0, "mfe_points": 2.0, "mae_points": -1.0, "lots": 5,
        "rupee_pnl": 37.5, "be_moved": True, "profit_locked": True,
        "first_target_bar": 2, "time_to_target_bars": 2, "blocked_reason": "",
    } for i in range(n)])
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.run("test run")
    log.trade("closed", net=0.5)
    return build_bundle(
        cfg, summarize(ledger, cfg), by_hypothesis(ledger, cfg),
        {"mean": 0.5, "lo": 0.1, "hi": 0.9, "n": n, "excludes_zero": True,
         "status": "TESTED"},
        {"p_value": 0.2, "null_mean": -1.0, "null_sd": 1.0, "null_median": -1.0,
         "n_perm": 20, "status": "TESTED", "observed_net": 3.0},
        None,
        {"signals_in": 40, "trades": n, "blocked": {"CHOPPY_REGIME": 10},
         "engine": {"shutdowns": 1}},
        {"TRENDING": 5, "COMPRESSING": 90, "CHOPPY": 20, "UNKNOWN": 1},
        {"VOLATILITY_COIL": "AVAILABLE",
         "OI_VELOCITY": "NOT_AVAILABLE (no open_interest field in dataset)"},
        {"atm_inside_ladder": 90}, {"futures": 100},
        None, ledger, log.lines, "BO-TEST", {"rows": 100}, 1234)


def test_bundle_contains_everything_the_tab_renders(tmp_path):
    b = _mini_bundle(tmp_path)
    for k in ("run_id", "wall_ms", "dataset", "settings", "config_fingerprint",
              "constraints", "regimes", "availability", "moneyness",
              "underlying_source", "summary", "by_hypothesis", "significance",
              "timing_test", "sensitivity", "audit", "signals", "ledger",
              "logic_map", "log"):
        assert k in b, f"bundle missing {k}"
    assert len(b["ledger"]) == 6
    assert len(b["log"]) == 2
    assert b["audit"]["blocked"]["CHOPPY_REGIME"] == 10


def test_bundle_states_the_hard_constraints_explicitly(tmp_path):
    c = _mini_bundle(tmp_path)["constraints"]
    assert c["long_only"] is True
    assert c["max_lots"] == 5
    assert c["breakeven_points"] == 2.5
    assert c["brokerage_points"] == pytest.approx(20.0 * 2 / 15, abs=1e-4)
    assert c["breakeven_trigger_points"] == pytest.approx(20.0 * 2 / 15 + 2.5, abs=1e-4)
    assert "RSI" in c["no_indicators"].upper()
    assert c["costs_charged"] is True


def test_bundle_is_json_serialisable_with_no_nan(tmp_path):
    b = _mini_bundle(tmp_path)
    text = json.dumps(b)          # must not raise
    assert "NaN" not in text and "Infinity" not in text


def test_clean_maps_non_finite_and_numpy_values():
    out = _clean({"a": float("nan"), "b": float("inf"), "c": np.int64(3),
                  "d": np.float64(1.5), "e": np.bool_(True),
                  "f": [np.float64("nan"), 1], "g": pd.Timestamp("2026-01-05")})
    assert out["a"] is None and out["b"] is None
    assert out["c"] == 3 and isinstance(out["c"], int)
    assert out["d"] == 1.5 and out["e"] is True
    assert out["f"] == [None, 1]
    assert out["g"].startswith("2026-01-05")


def test_bundle_survives_an_empty_run(tmp_path):
    """A blocked-everything run must still produce a renderable bundle."""
    cfg = BuyOnlySettings()
    empty = pd.DataFrame()
    log = RunLogger(outdir=str(tmp_path), level="info", echo=False)
    log.verdict("NO_TRADES")
    b = build_bundle(cfg, summarize(empty, cfg), by_hypothesis(empty, cfg),
                     {"status": "INSUFFICIENT_TRADES"}, None, None,
                     {"signals_in": 0, "trades": 0, "blocked": {}},
                     {}, {}, {}, {}, None, empty, log.lines, "BO-E", {}, 5)
    assert b["ledger"] == [] and b["signals"] == []
    assert b["summary"]["status"] == "NO_TRADES"
    json.dumps(b)


# ------------------------------------------------------------------ CLI wiring

def test_cli_writes_every_documented_artifact(tmp_path):
    from xbost_option_discovery.run_buyonly import main, load_quotes
    from tests_discovery.test_buyonly import synth_chain
    q = synth_chain(n=400, otype="CE")
    q["strike"] = q["strike"] + 55000.0
    q["symbol"] = q["symbol"] + "0"
    src = tmp_path / "chain.csv"
    q.to_csv(src, index=False)
    out = tmp_path / "out"
    emit = tmp_path / "emitted.json"
    rc = main(["--path", str(src), "--outdir", str(out),
               "--emit-bundle", str(emit), "--log-level", "debug",
               "--min-stop-points", "10", "--max-hold-bars", "15",
               "--timing-perms", "0"])
    assert rc == 0
    for name in ("run_log.txt", "audit.jsonl", "summary.json", "report.md",
                 "logic_map.md", "buyonly-bundle.json"):
        assert (out / name).exists(), f"missing artifact {name}"
    assert emit.exists(), "--emit-bundle must write the requested exact path"
    b = json.loads(emit.read_text())
    assert b["run_id"].startswith("BO-")
    assert len(b["log_text"]) > 0
    assert b["log_counts"], "log_counts must be populated"
    # the emitted bundle and the in-dir bundle are the same document
    assert json.loads((out / "buyonly-bundle.json").read_text())["run_id"] == b["run_id"]


def test_cli_log_records_gates_and_oi_absence(tmp_path):
    from xbost_option_discovery.run_buyonly import main
    from tests_discovery.test_buyonly import synth_chain
    q = synth_chain(n=400, otype="CE")
    q["strike"] = q["strike"] + 55000.0
    src = tmp_path / "c.csv"
    q.to_csv(src, index=False)
    out = tmp_path / "o"
    main(["--path", str(src), "--outdir", str(out), "--min-stop-points", "10",
          "--max-hold-bars", "15", "--timing-perms", "0"])
    kinds = [json.loads(l)["kind"] for l in (out / "audit.jsonl").read_text().splitlines()]
    assert "RUN" in kinds and "DATA" in kinds and "VERDICT" in kinds
    txt = (out / "run_log.txt").read_text()
    assert "OI_VELOCITY" in txt
    assert "ABSENT" in txt, "the missing OI field must be stated, not implied"
    assert "BREAKEVEN" not in txt  # sanity: no accidental uppercase contract


def test_cli_verdict_is_never_optimistic(tmp_path):
    """With no validated edge the verdict must not claim one."""
    from xbost_option_discovery.run_buyonly import main
    from tests_discovery.test_buyonly import synth_chain
    q = synth_chain(n=400, otype="CE")
    q["strike"] = q["strike"] + 55000.0
    src = tmp_path / "c.csv"
    q.to_csv(src, index=False)
    out = tmp_path / "o"
    main(["--path", str(src), "--outdir", str(out), "--min-stop-points", "10",
          "--max-hold-bars", "15", "--timing-perms", "0"])
    txt = (out / "run_log.txt").read_text()
    assert "VERDICT" in txt
    verdicts = [v for v in ("NO_TRADES", "NO_VALIDATED_EDGE", "VALIDATED_EDGE")
                if v in txt]
    assert verdicts, "a run must state a verdict"
    # "NO_VALIDATED_EDGE" must not be present alongside a bare VALIDATED_EDGE claim
    if "VALIDATED_EDGE" in txt:
        assert "NO_VALIDATED_EDGE" not in txt, \
            "the log claimed a validated edge while also reporting no validated edge"
    b = json.loads((out / "buyonly-bundle.json").read_text())
    assert b["constraints"]["costs_charged"] is True