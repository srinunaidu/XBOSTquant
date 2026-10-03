"""Symbol/expiry/contract identity tests (§39-§41): instrument isolation."""
import pandas as pd
import numpy as np

from xbost_option_discovery.identity import (
    assign_instruments, run_identity_tests, audit_pool_sum)
from xbost_option_discovery.features import add_raw
from xbost_option_discovery.labels import add_labels
from xbost_option_discovery.backtest import backtest


def _frame(rows_per=120, symbols=("A", "B"), expiries=("E1", "E2")):
    rows = []
    base = pd.Timestamp("2026-01-05 09:15")
    rng = np.random.default_rng(11)
    for sym in symbols:
        for e in expiries:
            for s in (100, 200):
                for o in ("CE", "PE"):
                    px = 100 + rng.normal(0, 1)
                    for b in range(rows_per):
                        ts = base + pd.Timedelta(minutes=b)
                        px = px + rng.normal(0, 0.5)
                        rows.append([ts, sym, e, s, o, f"{sym}{e}{s}{o}",
                                     px, px + 0.5, px - 0.5, px, 50])
    return pd.DataFrame(rows, columns=["timestamp", "underlying", "expiry",
                                       "strike", "option_type", "symbol",
                                       "open", "high", "low", "close",
                                       "volume"])


def test_instrument_split_across_expiry():
    n = _frame(symbols=("A",), expiries=("E1", "E2"))
    out, status = assign_instruments(n)
    # same strike/type across 2 expiries -> distinct instruments
    ce100 = out[(out["strike"].astype(str) == "100")
                & (out["option_type"] == "CE")]
    assert ce100["instrument_id"].nunique() == 2
    assert out["symbol"].nunique() == 1 * 2 * 2 * 2  # sym x exp x strike x type
    assert status == "KNOWN"


def test_unknown_symbol_status():
    n = _frame()
    n["underlying"] = "UNKNOWN"
    out, status = assign_instruments(n)
    assert status == "UNKNOWN"
    assert (out["symbol_id"] == "UNKNOWN").all()


def test_identity_battery_passes():
    n = _frame()
    out, _ = assign_instruments(n)
    feat = add_labels(add_raw(out))
    t = run_identity_tests(feat)
    assert t["instrument_multi_expiry"] == 0
    assert t["instrument_multi_symbol"] == 0
    assert t["forward_label_cross"] == 0
    assert t["rolling_cross"] == 0
    assert t["status"] == "PASS"


def test_pool_sum_matches():
    n = _frame(symbols=("A",), expiries=("E1",))
    out, _ = assign_instruments(n)
    feat = add_labels(add_raw(out))
    m = pd.Series(True, index=feat.index)
    pooled = backtest(feat, m, hold_bars=3, cid="P")
    parts = [backtest(feat, m & (feat["symbol"] == s), hold_bars=3,
                      cid="Q", verify=False)
             for s in feat["symbol"].unique()]
    r = audit_pool_sum(pooled, parts)
    assert r["pool_sum_match"] == "PASS", r


def test_trade_never_crosses_instrument():
    n = _frame(symbols=("A",), expiries=("E1",))
    out, _ = assign_instruments(n)
    feat = add_labels(add_raw(out))
    m = pd.Series(False, index=feat.index)
    m.iloc[::10] = True
    led = backtest(feat, m, hold_bars=5, cid="X")
    assert (led["contract_id"] == led["instrument_id"]).all()
    assert led["symbol_id"].notna().all()
    assert (pd.to_datetime(led["exit_time"])
            > pd.to_datetime(led["entry_time"])).all()
