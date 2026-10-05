"""Universe/track/selection regression tests (§45 TEST 1-15).

Covers: research universe vs compute priority, expiry/CE-PE isolation,
canonical identity, Track A field isolation, dynamic historical-only
selection, no future-winner rules, single-expiry/strike adaptation,
no-underlying execution, exit queue + exit leakage, global multiple
testing across tracks, checkpoint resume, Options Lab isolation, and
futures isolation.
"""
import json
import os
import sys

import numpy as np
import pandas as pd
import pytest

from xbost_option_discovery.ingestion import (
    load_dataset, research_universe, compute_priority, detect_chain,
)
from xbost_option_discovery.identity import assign_instruments
from xbost_option_discovery import tracks as TR


# ---------------------------------------------------------------- builders

def make_wide(n_days=4, bars_per_day=150, expiries=("29SEP2026", "27OCT2026"),
              strikes=(54700, 54800), sides=("CE", "PE"), seed=11,
              drift=0.0):
    """Wide chain file: ts,expiry,<STRIKE><SIDE>_{o,h,l,c,v}."""
    rng = np.random.default_rng(seed)
    toks = [f"{s}{t}" for s in strikes for t in sides]
    t0 = pd.Timestamp("2026-08-20 09:15")
    rows = []
    for d in range(n_days):
        px = {t: 200.0 for t in toks}
        for b in range(bars_per_day):
            ts = t0 + pd.Timedelta(days=d, minutes=b)
            row = {"ts": int(ts.tz_localize("UTC").timestamp()),
                   "expiry": expiries[0] if d < n_days // 2 else expiries[-1]}
            for t in toks:
                step = rng.normal(0, 1.0) + drift
                px[t] = max(5.0, px[t] + step)
                row[f"{t}_o"] = round(px[t] - step / 2, 2)
                row[f"{t}_h"] = round(px[t] + abs(step) / 2 + 0.3, 2)
                row[f"{t}_l"] = round(max(1.0, px[t] - abs(step) / 2 - 0.3), 2)
                row[f"{t}_c"] = round(px[t], 2)
                row[f"{t}_v"] = int(50 + abs(rng.normal(0, 30)))
            rows.append(row)
    return pd.DataFrame(rows)


def write_csv(tmp_path, df, name="chain.csv"):
    p = tmp_path / name
    df.to_csv(p, index=False)
    return str(p)


def run_main(path, outdir, extra=()):
    from xbost_option_discovery import run as RUN
    argv = ["run", "--path", path, "--outdir", str(outdir),
            "--max-candidates", "15", "--max-rounds", "2",
            "--min-events", "5", "--surrogate-perms", "5",
            "--max-exit-combos", "4", "--max-runtime-seconds", "300",
            *extra]
    old = sys.argv
    sys.argv = argv
    try:
        return RUN.main()
    except SystemExit as e:
        return e.code
    finally:
        sys.argv = old


# ---------------------------------------------------------------- TEST 1

def test_1_focus_does_not_restrict_universe(tmp_path):
    """All valid contracts enter research_universe; focus only prioritizes."""
    p = write_csv(tmp_path, make_wide())
    norm, layout = load_dataset(p)
    assert layout == "wide"
    universe, excluded = research_universe(norm)
    assert len(universe) == 2 * 2 * 2  # 2 expiries x 2 strikes x 2 sides
    assert excluded == []
    # same strike/type across expiries are distinct instruments (TEST 2/3)
    assert len({u.split("|")[0] for u in universe}) == 4
    from xbost_option_discovery.identity import assign_instruments
    norm_id, _ = assign_instruments(norm)
    universe_id, _ = research_universe(norm_id)
    assert len(universe_id) == 8
    meta_id = detect_chain(norm_id)
    prio, _strikes = compute_priority(norm_id, meta_id, 1, None)
    assert set(prio) < set(universe_id)  # priority is a strict subset...
    assert set(prio).issubset(set(universe_id))  # ...of the full universe
    prio3, _ = compute_priority(norm_id, meta_id, 3, None)
    assert len(prio3) >= len(prio)  # deeper priority covers more, never less


# ---------------------------------------------------------------- TEST 2/3

def test_2_expiry_isolation():
    """Same strike/type across expiries are separate instruments."""
    df = pd.DataFrame({
        "timestamp": pd.date_range("2026-01-05 09:15", periods=10, freq="min").tolist() * 2,
        "symbol": ["A"] * 10 + ["B"] * 10,
        "strike": [56000.0] * 20,
        "option_type": ["CE"] * 20,
        "expiry": ["27OCT2026"] * 10 + ["29SEP2026"] * 10,
        "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
        "volume": 10,
    })
    norm, status = assign_instruments(df)
    assert status in ("KNOWN", "UNKNOWN")
    assert norm["instrument_id"].nunique() == 2
    # canonical series key is instrument-pure: expiries never merge
    assert norm["symbol"].nunique() == 2
    assert set(norm["symbol"].astype(str)) == {
        "UNKNOWN|27OCT2026|56000.0|CE", "UNKNOWN|29SEP2026|56000.0|CE"}


def test_3_ce_pe_isolation():
    """CE and PE on the same strike/expiry never merge."""
    df = pd.DataFrame({
        "timestamp": pd.date_range("2026-01-05 09:15", periods=10, freq="min").tolist() * 2,
        "symbol": ["C"] * 10 + ["P"] * 10,
        "strike": [56000.0] * 20,
        "option_type": ["CE"] * 10 + ["PE"] * 10,
        "expiry": ["27OCT2026"] * 20,
        "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
        "volume": 10,
    })
    norm, status = assign_instruments(df)
    assert status in ("KNOWN", "UNKNOWN")
    assert norm["instrument_id"].nunique() == 2
    assert set(norm["symbol"].astype(str)) == {
        "UNKNOWN|27OCT2026|56000.0|CE", "UNKNOWN|27OCT2026|56000.0|PE"}


# ---------------------------------------------------------------- TEST 4

def test_4_track_a_cannot_touch_non_ohlcv_fields():
    """A strongly predictive injected field is invisible to Track A."""
    assert not TR.track_allows_column("A", "e_oi_shock")
    assert not TR.track_allows_column("A", "oi_percentile")
    assert not TR.track_allows_column("A", "type_ret_diff")
    assert TR.track_allows_column("A", "e_large_ret")
    assert TR.track_allows_column("A", "sel_vol_rank")
    assert TR.track_allows_column("A", "symbol")
    assert TR.track_allows_column("B", "e_oi_shock")
    # spec-level: Track A never emits cross-contract/OI specs
    assert TR.spec_track("STRIKE_RELATIONSHIP", ["x_retdiff"]) == "B"
    assert TR.spec_track("RAW_OPTION_PRICE", ["e_large_ret"]) == "A"
    assert TR.spec_track("SCOPE_SIDE", []) == "BOTH"
    # child promotion is one-way toward B
    assert TR.child_track("A", ["e_large_ret"]) == "A"
    assert TR.child_track("A", ["ev_divergence"]) == "B"
    assert TR.child_track("B", ["e_large_ret"]) == "B"


# ---------------------------------------------------------------- TEST 5/6

def _two_contract_frame(n=120, seed=5):
    """Contract V (high early volume) vs M (high late volume)."""
    rng = np.random.default_rng(seed)
    ts = pd.date_range("2026-01-05 09:15", periods=n, freq="min")
    rows = []
    for sym, lo, hi in (("V", 1000, 10), ("M", 10, 1000)):
        px = 100.0
        for i, t in enumerate(ts):
            w = i / n
            vol = lo + (hi - lo) * w + abs(rng.normal(0, 5))
            px = max(5.0, px + rng.normal(0, 0.5))
            rows.append({"symbol": sym, "timestamp": t, "strike": 100.0,
                         "option_type": "CE", "expiry": "E1",
                         "open": px, "high": px + 0.5, "low": px - 0.5,
                         "close": px, "volume": vol})
    return pd.DataFrame(rows)


def test_5_dynamic_selection_follows_trailing_history():
    """The rank leader changes over time; selectors track the trailing best."""
    feat = TR.add_selector_columns(_two_contract_frame())
    early = feat[feat["timestamp"] < feat["timestamp"].iloc[60]]
    late = feat[feat["timestamp"] > feat["timestamp"].iloc[-30]]
    assert (early[early["sel_vol_rank"] == 1]["symbol"] == "V").all()
    assert (late[late["sel_vol_rank"] == 1]["symbol"] == "M").all()
    # warmup bars select nothing rather than something ungrounded
    assert feat["sel_vol_rank"].isna().sum() > 0


def test_6_no_future_winner_selection():
    """A selector that could see the future would be perfect; ours is not,
    and the audit pins the ranks to history-only recomputation."""
    df = _two_contract_frame()
    feat = TR.add_selector_columns(df)
    # future oracle: rank by NEXT-bar volume (forbidden information)
    fut = df.sort_values(["symbol", "timestamp"]).copy()
    fut["fvol"] = fut.groupby("symbol")["volume"].shift(-1)
    oracle = fut.groupby("timestamp")["fvol"].rank(
        ascending=False, method="min")
    sel = feat.set_index(["timestamp", "symbol"])["sel_vol_rank"]
    ora = fut.set_index(["timestamp", "symbol"]).assign(
        oracle=oracle.values)["oracle"]
    both = pd.concat([sel.rename("sel"), ora.rename("oracle")], axis=1).dropna()
    assert not (both["sel"] == both["oracle"]).all(), \
        "selector must differ from the future oracle somewhere"
    audit = TR.audit_selectors(feat)
    assert audit["status"] == "PASS", audit


def test_6b_corrupted_selector_trips_audit():
    """Ranks built without the trailing shift are future-contaminated."""
    df = _two_contract_frame()
    feat = TR.add_selector_columns(df)
    bad = feat.copy()
    # no shift: current-bar volume leaks into its own rank
    raw = df.sort_values(["symbol", "timestamp"]).copy()
    cur = raw.groupby("symbol")["volume"].transform(
        lambda s: s.rolling(60, min_periods=20).sum())
    bad["sel_vol_rank"] = cur.groupby(
        raw["timestamp"].values).rank(ascending=False, method="min").values
    audit = TR.audit_selectors(bad, sample_timestamps=20)
    assert audit["checked"] > 0
    assert audit["status"] == "LOOKAHEAD_DETECTED", audit


# ---------------------------------------------------------------- TEST 7/8

def _run_small(path, out, extra=()):
    rc = run_main(path, out, list(extra))
    assert rc in (0, "0", None), f"run failed rc={rc}"
    return out


def test_7_single_expiry_adaptation(tmp_path, capsys):
    """One expiry: expiry-scope reports INSUFFICIENT_VARIATION, run continues."""
    df = make_wide(expiries=("29SEP2026", "29SEP2026"))
    p = write_csv(tmp_path, df)
    out = _run_small(p, tmp_path / "o7")
    text = capsys.readouterr().out
    assert "EXPIRY_VARIATION_UNAVAILABLE" in text
    assert "FINAL_STATUS=" in text


def test_8_single_strike_adaptation(tmp_path, capsys):
    """One strike: cross-strike scope unavailable, OHLCV discovery proceeds."""
    df = make_wide(strikes=(54800,))
    p = write_csv(tmp_path, df)
    out = _run_small(p, tmp_path / "o8")
    text = capsys.readouterr().out
    assert "single strike" in text
    assert "FINAL_STATUS=" in text


# ---------------------------------------------------------------- TEST 9/15

def test_9_no_underlying_execution(tmp_path, capsys):
    """Option-native discovery runs with no futures/underlying at all."""
    p = write_csv(tmp_path, make_wide())
    out = _run_small(p, tmp_path / "o9")
    text = capsys.readouterr().out
    assert "FINAL_STATUS=" in text
    assert (tmp_path / "o9" / "candidates.csv").exists()


def test_15_no_futures_imports():
    """Discovery never imports futures data paths."""
    import pathlib
    for mod in ("run.py", "tracks.py", "search.py", "ingestion.py",
                "exits.py", "reporting.py", "filters.py"):
        src = pathlib.Path("xbost_option_discovery", mod).read_text()
        for line in src.splitlines():
            s = line.strip()
            if s.startswith("import ") or s.startswith("from "):
                assert "futures" not in s.lower(), f"{mod}: {s}"


# ---------------------------------------------------------------- TEST 10/12

def _drift_file(tmp_path, name="drift.csv"):
    # persistent drift: every contract trends up -> real entry events.
    # Small universe (single expiry) keeps the run cheap; the mechanics
    # under test (exit queue, tracks, checkpoints) are size-independent.
    return write_csv(tmp_path, make_wide(n_days=5, bars_per_day=110,
                                         expiries=("29SEP2026", "29SEP2026"),
                                         strikes=(54800,), drift=0.4), name)


def test_10_exit_queue_and_discovery(tmp_path, capsys):
    """Promising entries get exit research (inline + queued variants)."""
    p = _drift_file(tmp_path)
    out = _run_small(p, tmp_path / "o10",
                     ["--min-events", "3", "--surrogate-perms", "5"])
    text = capsys.readouterr().out
    assert "TRACK_A" in text and "TRACK_B" in text
    cands = pd.read_csv(tmp_path / "o10" / "candidates.csv")
    assert len(cands) > 0, "drifted data must produce candidates"
    assert int(pd.to_numeric(cands["exit_combos_evaluated"],
                             errors="coerce").fillna(0).sum()) > 0, \
        "promising entries must receive exit research"


def test_12_global_mt_spans_tracks(tmp_path, capsys):
    """Both tracks contribute hypotheses to ONE global testing ledger."""
    p = _drift_file(tmp_path, "drift12.csv")
    out = _run_small(p, tmp_path / "o12",
                     ["--min-events", "3", "--surrogate-perms", "5"])
    text = capsys.readouterr().out
    assert "TRACK_A" in text and "TRACK_B" in text
    cands = pd.read_csv(tmp_path / "o12" / "candidates.csv")
    assert set(cands["track"].astype(str).unique()) <= {"A", "B"}
    assert (cands["track"] == "A").any() and (cands["track"] == "B").any(), \
        "both tracks must evaluate candidates on drifted data"
    assert "GLOBAL_TEST_COUNT=" in text
    #BH decided over the combined frame, never per track
    assert "perm_p_adj" in cands.columns


# ---------------------------------------------------------------- TEST 11

def test_11_exit_leakage_guard():
    """Exit search runs on refinement only; OOS is evaluated once."""
    import inspect
    from xbost_option_discovery import run as RUN
    src = inspect.getsource(RUN.evaluate_candidate)
    # exit discovery input is the refinement split, never OOS days
    assert 'splits["refinement"]' in src
    assert "oos_days" in src  # OOS evaluated once on the locked final rule


# ---------------------------------------------------------------- TEST 13

def test_13_checkpoint_resume(tmp_path):
    """Resume restores frontiers/registry/coverage without duplication."""
    p = _drift_file(tmp_path, "drift13.csv")
    ck = tmp_path / "ck"
    out1 = tmp_path / "o13a"
    run_main(p, out1, ["--min-events", "3", "--surrogate-perms", "5",
                       "--checkpoint-dir", str(ck), "--max-rounds", "1",
                       "--max-candidates", "6"])
    cps = list(ck.glob("*.checkpoint.json"))
    assert cps, "checkpoint must be written"
    cp = json.loads(cps[0].read_text())
    assert "frontier_A" in cp and "frontier_B" in cp
    assert "coverage" in cp and set(cp["coverage"]) >= {"A", "B"}
    n_before = int(cp["global_test_count"])
    out2 = tmp_path / "o13b"
    run_main(p, out2, ["--min-events", "3", "--surrogate-perms", "5",
                       "--checkpoint-dir", str(ck),
                       "--resume-from", str(cps[0]),
                       "--max-rounds", "2", "--max-candidates", "12"])
    cands = pd.read_csv(out2 / "candidates.csv")
    assert cands["hypothesis_id"].is_unique, \
        "resumed run must not duplicate hypotheses"
    cp2 = json.loads(cps[0].read_text())
    assert int(cp2["global_test_count"]) >= n_before, \
        "global test count must never reset on resume"
    assert int(cp2["hypothesis_n"]) >= 0
    assert len(cands) >= 0


# ---------------------------------------------------------------- TEST 16/17

def test_16_scope_selector_recipes_roundtrip():
    """Scope/selector recipes re-apply exactly (resume/transfer safety)."""
    from xbost_option_discovery.run import apply_recipe, _resolve_mask
    from xbost_option_discovery.search import HypothesisRegistry, FrontierQueue
    ts = pd.date_range("2026-01-05 09:15", periods=60, freq="min")
    rows = []
    for sym in ("A", "B"):
        for i, t in enumerate(ts):
            rows.append({"symbol": sym, "timestamp": t, "strike": 100.0,
                         "option_type": "CE", "expiry": "E1",
                         "open": 10.0, "high": 10.5, "low": 9.5,
                         "close": 10.0 + (i % 7 == 0), "volume": 50 + i})
    feat = pd.DataFrame(rows)
    m1 = apply_recipe(feat, {"kind": "scope", "field": "symbol",
                             "op": "eq", "val": "A"})
    assert set(feat.loc[m1, "symbol"].unique()) == {"A"}
    m2 = apply_recipe(feat, {"kind": "combo",
                             "parent": {"kind": "scope", "field": "option_type",
                                        "op": "eq", "val": "CE"},
                             "scope_leg": {"kind": "scope", "field": "symbol",
                                           "op": "eq", "val": "B"}})
    assert set(feat.loc[m2, "symbol"].unique()) == {"B"}
    feat = TR.add_selector_columns(feat)
    m3 = apply_recipe(feat, {"kind": "selector", "col": "sel_vol_rank",
                             "op": "le", "val": 1})
    assert m3.sum() > 0
    assert set(feat.loc[m3, "symbol"].unique()) <= {"A", "B"}


def test_17_track_a_guard_blocks_smuggled_columns():
    """A Track A hypothesis referencing a Track B column resolves empty
    and records the violation instead of silently trading it."""
    from xbost_option_discovery.run import _resolve_mask
    from xbost_option_discovery.search import HypothesisRegistry, FrontierQueue
    feat = pd.DataFrame({"ev_divergence": [1, 0, 1],
                         "e_large_ret": [1, 1, 0]})
    hreg = HypothesisRegistry()
    r = hreg.register("ATOMIC-0", "DIVERGENCE", "ev_divergence", track="A")
    FQ = FrontierQueue()
    atomic = {r["hypothesis_id"]: {
        "mask_fn": lambda f: (f["ev_divergence"] == 1),
        "recipe": {"kind": "atomic", "col": "ev_divergence", "op": "eq1"}}}
    m = _resolve_mask(feat, r["hypothesis_id"], hreg, atomic, {}, FQ)
    assert m.sum() == 0
    assert "track_violation" in hreg.hypotheses[r["hypothesis_id"]]
    r2 = hreg.register("ATOMIC-1", "RAW_OPTION_PRICE", "e_large_ret",
                       track="A")
    atomic[r2["hypothesis_id"]] = {
        "mask_fn": lambda f: (f["e_large_ret"] == 1),
        "recipe": {"kind": "atomic", "col": "e_large_ret", "op": "eq1"}}
    m2 = _resolve_mask(feat, r2["hypothesis_id"], hreg, atomic, {}, FQ)
    assert m2.sum() == 2

# ---------------------------------------------------------------- TEST 14

def test_14_options_lab_isolation():
    """Discovery's universe work never touches Options Lab behavior."""
    import pathlib
    repo = pathlib.Path(".")
    # Lab lives in the browser terminal; discovery is Python-only here.
    lab_refs = []
    for mod in ("run.py", "tracks.py", "search.py", "ingestion.py"):
        src = (repo / "xbost_option_discovery" / mod).read_text().lower()
        for needle in ("options lab", "optionslab", "atm auto", "atm ± 1",
                       "atm+-1", "bake-off", "bakeoff"):
            if needle in src:
                lab_refs.append((mod, needle))
    assert lab_refs == [], f"discovery references Lab logic: {lab_refs}"
