"""Structural tests (§39). Run must fail if any structural test fails."""
import pandas as pd
from xbost_option_discovery import ingestion, chain_normalizer, leakage
from xbost_option_discovery.features import add_raw, add_volume
from xbost_option_discovery.relationships import add_cepe
from xbost_option_discovery.labels import add_labels
from xbost_option_discovery.validation import splits_50_20_30
from xbost_option_discovery.backtest import backtest, fingerprint

PATH = "Data test/banknifty_options.csv"

def test_six_contracts():
    norm, _ = ingestion.load_dataset(PATH)
    _, strikes, chain = ingestion.select_chain(norm, 3)
    assert len(chain) == 6, f"CONTRACTS={len(chain)}"
    for c in chain:
        assert c.endswith("CE") or c.endswith("PE")

def test_sync_and_expiry():
    norm, _ = ingestion.load_dataset(PATH)
    exps, _ = chain_normalizer.audit_expiry(norm)
    assert len(exps) == 1
    h = ingestion.data_health(norm, ingestion.select_chain(norm, 3)[2])
    assert h["status"] in ("DATA_VALID", "DATA_PARTIAL")

def test_no_lookahead():
    norm, _ = ingestion.load_dataset(PATH)
    sub, _, _ = ingestion.select_chain(norm.head(3000), 3)
    f = add_raw(sub)
    f = add_volume(f)
    f = add_labels(f)
    r = leakage.test_no_lookahead(f, [])
    assert r["PASS"]

def test_cepe_cross_pairing():
    norm, _ = ingestion.load_dataset(PATH)
    sub, strikes, _ = ingestion.select_chain(norm.head(3000), 3)
    f = add_raw(sub); f = add_volume(f); f = add_cepe(f)
    assert "cepe_ret_diff" in f.columns

def test_oos_order():
    days = sorted(pd.to_datetime(pd.read_csv(PATH, usecols=["date"])["date"]).dt.date.unique().tolist())
    s = splits_50_20_30(days)
    assert max(s["discovery"]) < min(s["refinement"]) <= max(s["refinement"]) < min(s["pseudo_oos"])

def test_exit_propagation():
    norm, _ = ingestion.load_dataset(PATH)
    sub, _, _ = ingestion.select_chain(norm.head(3000), 3)
    f = add_raw(sub); f = add_volume(f); f = add_labels(f)
    m = f["return_5"].abs() > 99
    m.iloc[0] = True
    bt = backtest(f, m, sl=1.5, tp=2.5, exit_mode="fixed", cid="T")
    assert bt["fingerprint"].str.contains("sl=1.5").all()
    assert fingerprint("T", 1.5, 2.5, None, "fixed") in bt["fingerprint"].values
