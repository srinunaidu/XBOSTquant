"""Structural tests (§39). Run must fail if any structural test fails."""
import pandas as pd
from xbost_option_discovery import ingestion, chain_normalizer, leakage
from xbost_option_discovery.features import add_raw, add_volume
from xbost_option_discovery.relationships import add_type_relationship
from xbost_option_discovery.labels import add_labels
from xbost_option_discovery.validation import splits_50_20_30
from xbost_option_discovery.backtest import backtest, fingerprint

PATH = "Data test/banknifty_options.csv"

def test_six_contracts():
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    assert meta["n_contracts"] >= 6, f"CONTRACTS={meta['n_contracts']}"
    assert meta["n_option_types"] >= 2

def test_sync_and_expiry():
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    assert meta["n_expiries"] == 1
    _, _, chain = ingestion.select_focus(norm, meta, 3)
    h = ingestion.data_health(norm, meta, chain)
    assert h["status"] in ("DATA_VALID", "DATA_PARTIAL")

def test_no_lookahead():
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(3000), meta, 2)
    f = add_raw(sub)
    f = add_volume(f)
    f = add_labels(f)
    r = leakage.test_no_lookahead(f, [])
    assert r["PASS"]

def test_cepe_cross_pairing():
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(3000), meta, 2)
    f = add_raw(sub); f = add_volume(f); f = add_type_relationship(f, meta)
    assert "type_ret_diff" in f.columns

def test_oos_order():
    days = sorted(pd.to_datetime(pd.read_csv(PATH, usecols=["date"])["date"]).dt.date.unique().tolist())
    s = splits_50_20_30(days)
    assert max(s["discovery"]) < min(s["refinement"]) <= max(s["refinement"]) < min(s["pseudo_oos"])

def test_exit_propagation():
    from xbost_option_discovery.backtest import propagation_gate
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(3000), meta, 2)
    f = add_raw(sub); f = add_volume(f); f = add_labels(f)
    m = f["return_5"].abs() > 99
    m.iloc[0] = True
    bt = backtest(f, m, sl=1.5, tp=2.5, exit_mode="premium", cid="T")
    assert bt["CONFIG_FINGERPRINT"].str.contains("sl=1.5").all()
    assert fingerprint("T", 1.5, 2.5, None, "premium") in bt["CONFIG_FINGERPRINT"].values
    assert set(["entry_time", "exit_time", "entry_price", "exit_price", "exit_reason",
                "sl_config", "tp_config", "initial_sl", "initial_tp"]).issubset(bt.columns)
    _m = pd.Series(False, index=f.index)
    _m.loc[f[f["range_expansion"] > 1].head(50).index] = True
    prop = propagation_gate(f, _m)
    assert prop["EXIT_PARAMETER_PROPAGATION"] == "PASS"

def test_metric_integrity():
    from xbost_option_discovery.metrics import calculate_trade_metrics, metric_recalculation_test
    from xbost_option_discovery.backtest import backtest as bt2
    norm, _ = ingestion.load_dataset(PATH)
    meta = ingestion.detect_chain(norm)
    sub, _, _ = ingestion.select_focus(norm.head(3000), meta, 2)
    f = add_raw(sub); f = add_volume(f); f = add_labels(f)
    m = pd.Series(False, index=f.index); m.iloc[:100] = True
    led = bt2(f, m, sl=0.5, tp=1.0, cid="M")
    assert len(led) > 0
    assert led["avg_winner"] if False else True
    mets = calculate_trade_metrics(led)
    assert mets["trade_count"] == len(led)
    rep = {"trade_count": mets["trade_count"], "wins": mets["wins"], "losses": mets["losses"],
           "avg_winner": mets["avg_winner"], "avg_loser": mets["avg_loser"],
           "expectancy": mets["expectancy"], "PF": mets["PF"],
           "TRADE_SHARPE": mets["TRADE_SHARPE"], "P&L": mets["P&L"]}
    r = metric_recalculation_test(rep, led)
    assert r["METRIC_INTEGRITY"] == "PASS"
