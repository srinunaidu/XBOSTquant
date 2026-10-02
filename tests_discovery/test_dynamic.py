"""Dynamic-dataset tests (§27): same engine, unseen structures, no code changes."""
import os
import re
import numpy as np
import pandas as pd

from xbost_option_discovery import ingestion
from xbost_option_discovery.features import add_raw, add_volume
from xbost_option_discovery.relationships import add_type_relationship, add_crossstrike, add_breadth
from xbost_option_discovery.labels import add_labels
from xbost_option_discovery.backtest import backtest
from xbost_option_discovery.metrics import calculate_trade_metrics, metric_recalculation_test
from xbost_option_discovery.validation import chronological_splits


def _synth_long(path, strikes, otypes, expiries, colmap, n_days=8, seed=7):
    rng = np.random.default_rng(seed)
    rows = []
    base = pd.Timestamp("2026-01-05 09:15")
    t = 0
    for d in range(n_days):
        for b in range(60):
            ts = base + pd.Timedelta(days=d, minutes=b)
            for e in expiries:
                for s in strikes:
                    for o in otypes:
                        px = 100 + rng.normal(0, 2)
                        rows.append([ts, e, s, o, f"U{e}{s}{o}", px,
                                     px + abs(rng.normal(0, 1)), px - abs(rng.normal(0, 1)),
                                     px + rng.normal(0, 0.5), int(abs(rng.normal(50, 20)))])
            t += 1
    df = pd.DataFrame(rows, columns=["date", "expiry", "strike", "otype", "symbol",
                                     "open", "high", "low", "close", "volume"])
    df = df.rename(columns={v: k for k, v in colmap.items()})
    # colmap maps canonical->actual; invert: rename actual cols to canonical names first
    df.to_csv(path, index=False)
    return path


def _run_pipeline(norm, meta):
    sub = norm[norm["symbol"].isin(meta["contracts"][:6])].copy()
    f = add_raw(sub)
    f = add_volume(f)
    if meta["n_option_types"] >= 2:
        f = add_type_relationship(f, meta)
    if meta["n_strikes"] >= 2:
        f = add_crossstrike(f, meta, meta["strikes"][:2])
    f = add_breadth(f, meta)
    f = add_labels(f)
    m = pd.Series(False, index=f.index)
    m.iloc[:60] = True
    led = backtest(f, m, cid="DYN")
    mets = calculate_trade_metrics(led)
    rep = {k: mets[k] for k in ("trade_count", "wins", "losses", "avg_winner", "avg_loser",
                                "expectancy", "PF", "TRADE_SHARPE", "P&L")}
    assert metric_recalculation_test(rep, led)["METRIC_INTEGRITY"] == "PASS"
    return f, led


def test_different_strikes_otypes_expiries(tmp_path):
    # C/P tokens, 2 strikes, 3 expiries, custom symbol scheme
    p = str(tmp_path / "alt1.csv")
    _synth_long(p, strikes=[100, 200], otypes=["C", "P"],
                expiries=["JAN", "FEB", "MAR"], colmap={})
    norm, layout = ingestion.load_dataset(p)
    assert layout == "long"
    meta = ingestion.detect_chain(norm)
    assert meta["n_strikes"] == 2 and meta["n_option_types"] == 2 and meta["n_expiries"] == 3
    assert set(meta["option_types"]) == {"C", "P"}
    mods = ingestion.module_availability(meta)
    assert mods["OPTION_TYPE_RELATIONSHIP"][0] == "AVAILABLE"
    assert mods["STRIKE_RELATIONSHIP"][0] == "AVAILABLE"
    assert mods["EXPIRY_RELATIONSHIP"][0] == "AVAILABLE"
    _run_pipeline(norm, meta)


def test_different_column_names(tmp_path):
    # ts/exp/strike_px/cp/o/h/l/c/v naming convention
    p = str(tmp_path / "alt2.csv")
    _synth_long(p, strikes=[50, 60, 70], otypes=["Call", "Put"], expiries=["W1"], colmap={})
    df = pd.read_csv(p)
    df = df.rename(columns={"date": "ts", "expiry": "exp", "strike": "strike_px",
                            "otype": "cp", "symbol": "contract", "open": "o", "high": "h",
                            "low": "l", "close": "c", "volume": "v"})
    df.to_csv(p, index=False)  # otype values already Call/Put; loader normalizes them
    norm, _ = ingestion.load_dataset(p)
    meta = ingestion.detect_chain(norm)
    assert meta["n_strikes"] == 3 and meta["n_option_types"] == 2
    _run_pipeline(norm, meta)


def test_wide_custom_naming(tmp_path):
    # wide form: SIDEWAYS_99_CALL_open style tokens
    rng = np.random.default_rng(3)
    ts = pd.date_range("2026-02-02 09:15", periods=300, freq="min")
    df = pd.DataFrame({"ts": ts, "exp": "W1"})
    for tok in ["SIDEWAYS_99_CALL", "SIDEWAYS_99_PUT", "SIDEWAYS_101_CALL", "SIDEWAYS_101_PUT"]:
        px = 50 + rng.normal(0, 1, len(ts)).cumsum() * 0.1 + 50
        df[f"{tok}_o"] = px
        df[f"{tok}_h"] = px + 0.5
        df[f"{tok}_l"] = px - 0.5
        df[f"{tok}_c"] = px + rng.normal(0, 0.2, len(ts))
        df[f"{tok}_v"] = 100
    p = str(tmp_path / "wide.csv")
    df.to_csv(p, index=False)
    norm, layout = ingestion.load_dataset(p)
    assert layout == "wide"
    meta = ingestion.detect_chain(norm)
    assert meta["n_contracts"] == 4


def test_single_strike_single_type_degrades_gracefully(tmp_path):
    p = str(tmp_path / "thin.csv")
    _synth_long(p, strikes=[10], otypes=["CE"], expiries=["E1"], colmap={}, n_days=8)
    norm, _ = ingestion.load_dataset(p)
    meta = ingestion.detect_chain(norm)
    mods = ingestion.module_availability(meta)
    assert mods["STRIKE_RELATIONSHIP"][0] == "UNAVAILABLE"
    assert mods["OPTION_TYPE_RELATIONSHIP"][0] == "UNAVAILABLE"
    assert mods["EXPIRY_RELATIONSHIP"][0] == "UNAVAILABLE"
    assert mods["OPTION_DATA"][0] == "AVAILABLE"  # engine adapts, does not fail


def test_short_sample_flags_insufficient_validation(tmp_path):
    p = str(tmp_path / "short.csv")
    _synth_long(p, strikes=[10, 20], otypes=["CE", "PE"], expiries=["E1"], colmap={}, n_days=2)
    norm, _ = ingestion.load_dataset(p)
    meta = ingestion.detect_chain(norm)
    mods = ingestion.module_availability(meta, min_oos_days=6)
    assert mods["OOS_VALIDATION"][0] == "UNAVAILABLE"  # VALIDATION_INSUFFICIENT_DATA
    assert chronological_splits([1, 2]) is None


def test_no_hardcoded_contract_assumptions():
    """§26: engine source must not embed specific strikes/symbols/counts/expiries."""
    root = os.path.join(os.path.dirname(__file__), "..", "xbost_option_discovery")
    banned = [r"\b54\d{3}(CE|PE|C|P)?\b", r"\b55\d{3}(CE|PE)\b", r"29SEP\d{4}",
              r"EXPECTED_\w*STRIKE", r"EXPECTED_\d+", r"==\s*6\b.*contract",
              r'if strike ==', r'if symbol ==', r'if contracts ==', r'if expiry ==',
              r'\["CE",\s*"PE"\]', r"\['CE',\s*'PE'\]"]
    hits = []
    for fn in sorted(os.listdir(root)):
        if not fn.endswith(".py"):
            continue
        src = open(os.path.join(root, fn)).read()
        for pat in banned:
            for m in re.finditer(pat, src):
                line = src[max(0, m.start() - 60):m.end() + 60].split("\n")[0]
                hits.append(f"{fn}: {line.strip()}")
    assert not hits, f"hardcoded assumptions found:\n" + "\n".join(hits)


def test_reported_wide_shape_parses_contracts(tmp_path):
    """Reported failure: 12-contract / 2-expiry wide file parsed as UNKNOWN/0.
    Must yield 12 registry rows, valid strikes/types, non-empty focus chain."""
    import datetime
    import random
    from xbost_option_discovery import ingestion
    random.seed(5)
    toks = [f"BNF{e}{s}{t}" for e in ["29SEP26", "27OCT26"]
            for s in [54700, 54800, 54900] for t in ["CE", "PE"]]
    head = ["ts", "expiry"] + [c for t in toks for c in
                               [t + "_o", t + "_h", t + "_l", t + "_c", t + "_v"]]
    lines = [",".join(head)]
    t0 = datetime.datetime(2026, 8, 20, 9, 15)
    for b in range(300):
        ts = (t0 + datetime.timedelta(minutes=b)).strftime("%Y-%m-%d %H:%M:%S")
        exp = "29SEP2026" if b < 200 else "27OCT2026"
        row = [ts, exp]
        for t in toks:
            px = 200 + random.uniform(-25, 25)
            row += [f"{px:.2f}", f"{px + 1:.2f}", f"{px - 1:.2f}",
                    f"{px + random.uniform(-1, 1):.2f}", "100"]
        lines.append(",".join(row))
    p = str(tmp_path / "wide12.csv")
    open(p, "w").write("\n".join(lines))
    norm, layout = ingestion.load_dataset(p)
    assert layout == "wide"
    reg = ingestion.build_registry(norm, layout)
    assert len(reg) == 12
    assert sum(1 for r in reg if str(r["strike"]) != "nan") == 12
    assert sum(1 for r in reg if r["option_type"] != "UNKNOWN") == 12
    assert {s for r in reg for s in r["expiry"]} >= {"29SEP2026", "27OCT2026"}
    assert sorted(set(r["strike"] for r in reg)) == [54700.0, 54800.0, 54900.0]
    meta = ingestion.detect_chain(norm)
    sub, strikes, chain = ingestion.select_focus(norm, meta, 3)
    assert len(chain) > 0  # FOCUS chain (0) regression


def test_symbol_grouping_no_cross_expiry_contamination(tmp_path):
    """Same strike+otype in two expiries must never share a shift chain."""
    import pandas as pd
    from xbost_option_discovery.features import add_raw
    from xbost_option_discovery.labels import add_labels
    rows = []
    base = pd.Timestamp("2026-03-02 09:15")
    for b in range(100):
        ts = (base + pd.Timedelta(minutes=b)).strftime("%Y-%m-%d %H:%M:%S")
        # SEP contract drifts up, OCT contract drifts down — contamination would flip signs
        rows.append([ts, "E1", 100, "CE", "S1", 100 + b, 101 + b, 99 + b, 100 + b, 50])
        rows.append([ts, "E2", 100, "CE", "S2", 200 - b, 201 - b, 199 - b, 200 - b, 50])
    df = pd.DataFrame(rows, columns=["timestamp", "expiry", "strike", "option_type",
                                     "symbol", "open", "high", "low", "close", "volume"])
    p = str(tmp_path / "twoexp.csv")
    df.to_csv(p, index=False)
    from xbost_option_discovery import ingestion
    norm, _ = ingestion.load_dataset(p)
    feat = add_labels(add_raw(norm))
    s1 = feat[feat["symbol"] == "S1"].sort_values("timestamp").reset_index(drop=True)
    s2 = feat[feat["symbol"] == "S2"].sort_values("timestamp").reset_index(drop=True)
    assert (s1["return_1"].dropna() > 0).all()  # pure up drift, no OCT contamination
    assert (s2["return_1"].dropna() < 0).all()  # pure down drift, no SEP contamination
    assert (s1["fwd_ret_1m"].dropna() > 0).all()
    assert (s2["fwd_ret_1m"].dropna() < 0).all()


def test_backtest_skips_nan_without_nan_pnl(tmp_path):
    import pandas as pd
    import numpy as np
    from xbost_option_discovery import ingestion
    from xbost_option_discovery.features import add_raw, add_volume
    from xbost_option_discovery.labels import add_labels
    from xbost_option_discovery.backtest import backtest
    norm, _ = ingestion.load_dataset("Data test/banknifty_options.csv")
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(6000), meta, 2)
    feat = add_labels(add_volume(add_raw(sub)))
    feat.loc[feat.index[::7], "close"] = np.nan  # sparse-contract gaps
    m = pd.Series(False, index=feat.index)
    m.iloc[:200] = True
    led = backtest(feat, m, cid="GAP")
    rets = pd.to_numeric(led["ret"], errors="coerce")
    assert rets.notna().all() and np.isfinite(rets).all()
    assert (led.attrs.get("SKIPPED", {}).get("nan_exit", 0) or 0) > 0 or len(led) > 0


def test_lookahead_audit_passes_on_real_sample():
    from xbost_option_discovery import ingestion, leakage
    from xbost_option_discovery.chain_normalizer import normalize
    from xbost_option_discovery.features import add_raw, add_volume
    from xbost_option_discovery.labels import add_labels
    norm, _ = ingestion.load_dataset("Data test/banknifty_options.csv")
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(20000), meta, 3)
    feat = add_labels(add_volume(add_raw(sub)))
    r = leakage.audit_lookahead(feat)
    assert r["status"] == "PASS", r["first_mismatch"]
    assert r["label_tests"] >= 10
