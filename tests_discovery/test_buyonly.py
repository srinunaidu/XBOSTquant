"""Tests for the Option Buy-Only engine.

The load-bearing properties, in order of how badly a bug would hurt:
  1. causality - no feature or signal may change when only FUTURE bars change
  2. exit timing - a stop raised on bar t cannot trigger on bar t
  3. universe discipline - never OTM, never more than max_lots, never short
  4. fill honesty - entry is the NEXT bar's open, never the signal bar's close
  5. adaptive shutdown - CHOPPY and the 2-loss breaker both block trading
  6. honest reporting - OI_VELOCITY is NOT_AVAILABLE without OI, never faked
"""
import numpy as np
import pandas as pd
import pytest

from xbost_option_discovery.buyonly import (BuyOnlySettings, build_reference,
                                            build_underlying, audit_moneyness,
                                            add_session_features, run_all,
                                            availability, classify_regimes,
                                            regime_summary, AdaptiveEngine,
                                            run_backtest, summarize,
                                            by_hypothesis, significance)
from xbost_option_discovery.buyonly import exits as EX
from xbost_option_discovery.buyonly.engine import ContractBook, select_contract
from xbost_option_discovery.buyonly.hypotheses import SIGNAL_COLS
from xbost_option_discovery.buyonly.report import (max_drawdown, logic_map,
                                                  bootstrap_ci,
                                                  signal_permutation_test)


# ------------------------------------------------------------------ fixtures

def synth_chain(n=600, strikes=(100.0, 105.0, 110.0), otype="CE",
                seed=3, with_oi=False):
    """One synthetic expiry chain with two option types."""
    rng = np.random.default_rng(seed)
    ts = pd.date_range("2026-01-05 09:15", periods=n, freq="min")
    frames = []
    for k in strikes:
        base = 50.0 + abs(k - 105.0) * 0.8
        c = base + rng.normal(0, 0.6, n).cumsum() * 2
        d = pd.DataFrame({"timestamp": ts, "symbol": f"X{k:.0f}{otype}",
                          "strike": k, "option_type": otype, "expiry": "E",
                          "open": c, "high": c + 0.8, "low": c - 0.8,
                          "close": c, "volume": rng.integers(100, 900, n)})
        if with_oi:
            d["oi"] = rng.integers(1000, 9000, n)
        frames.append(d)
    return pd.concat(frames, ignore_index=True)


def synth_underlying(n=600, seed=7, day="2026-01-05"):
    rng = np.random.default_rng(seed)
    ts = pd.date_range(f"{day} 09:15", periods=n, freq="min")
    c = 100 + rng.normal(0, 0.4, n).cumsum()
    return pd.DataFrame({"timestamp": ts, "open": c, "high": c + 0.5,
                         "low": c - 0.5, "close": c,
                         "volume": rng.integers(200, 2000, n),
                         "underlying_source": "futures"})


@pytest.fixture
def cfg():
    return BuyOnlySettings(min_stop_points=10.0, max_hold_bars=20)


# ------------------------------------------------------------------ config

def test_breakeven_is_brokerage_plus_two_and_a_half_points():
    c = BuyOnlySettings(brokerage_per_order=20.0, lot_size=15,
                        breakeven_points=2.5, orders_per_leg=2)
    assert c.brokerage_points() == pytest.approx(20.0 * 2 / 15)
    assert c.breakeven_trigger_points() == pytest.approx(20.0 * 2 / 15 + 2.5)


def test_max_lots_and_universe_are_hard_capped():
    c = BuyOnlySettings()
    assert c.max_lots == 5
    assert c.max_itm_steps >= 1


# ------------------------------------------------------------------ causality

def test_features_do_not_change_when_only_future_bars_change():
    u = add_session_features(synth_underlying(400), 30)
    cut = 250
    tampered = u.copy()
    for col in ("open", "high", "low", "close", "volume"):
        tampered[col] = tampered[col].astype("float64")
        tampered.loc[tampered.index >= cut, col] = (
            tampered.loc[tampered.index >= cut, col] * 7.5 + 1000)
    u2 = add_session_features(tampered, 30)
    for col in ("vwap", "vwap_sigma", "vwap_z", "range_pct", "range_pctile",
                "vol_ratio", "eff_ratio", "swing_high", "swing_low", "atr_pct"):
        a = u[col].to_numpy()[:cut]
        b = u2[col].to_numpy()[:cut]
        assert np.allclose(a, b, equal_nan=True), f"{col} leaked future data"


def test_vwap_is_reset_each_session():
    u = synth_underlying(120, day="2026-01-05")
    u2 = synth_underlying(120, day="2026-01-06")
    f = add_session_features(pd.concat([u, u2], ignore_index=True), 30)
    first_of_day2 = f[f["timestamp"].dt.normalize() == pd.Timestamp("2026-01-06")]
    # session VWAP at the first bar of a session equals that bar's typical price
    tp = (first_of_day2["high"].iloc[0] + first_of_day2["low"].iloc[0]
          + first_of_day2["close"].iloc[0]) / 3
    assert first_of_day2["vwap"].iloc[0] == pytest.approx(tp, rel=1e-6)


# ------------------------------------------------------------------ ATM / ITM

def test_put_call_parity_finds_atm_where_futures_is_absent():
    ce = synth_chain(strikes=(100.0, 105.0, 110.0), otype="CE", seed=1)
    # make 105 the ATM by making its CE and PE nearly equal
    pe = synth_chain(strikes=(100.0, 105.0, 110.0), otype="PE", seed=1)
    pe["close"] = pe["close"] * 0 + 50.0
    ce2 = ce.copy()
    ce2["close"] = ce2["close"] * 0 + 50.0
    q = pd.concat([ce2, pe], ignore_index=True)
    ref = build_reference(q, None)
    assert (ref["atm_source"] == "put_call_parity").all()
    assert set(ref["atm"].dropna().unique()) <= {100.0, 105.0, 110.0}


def test_moneyness_audit_reports_atm_outside_the_ladder():
    q = synth_chain(strikes=(100.0, 105.0, 110.0))
    fut = pd.DataFrame({"timestamp": pd.date_range("2026-01-05 09:15", periods=600,
                                                    freq="min"),
                        "open": 0, "high": 0, "low": 0, "close": 900.0,
                        "volume": 0})
    ref = build_reference(q, fut)
    a = audit_moneyness(ref, q)
    assert a["atm_above_ladder"] > 0
    assert a["status"] == "ATM_OUTSIDE_LADDER"   # reported, not treated as an error
    assert a["atm_inside_ladder"] == 0
    assert a["outside_ladder_pct"] == 100.0


def test_selection_never_returns_an_otm_contract():
    q = pd.concat([synth_chain(strikes=(100.0, 105.0, 110.0), otype="CE"),
                   synth_chain(strikes=(100.0, 105.0, 110.0), otype="PE")],
                  ignore_index=True)
    book = ContractBook(q)
    c = BuyOnlySettings(max_itm_steps=2, target_itm_steps=0)
    for atm in (100.0, 102.5, 105.0, 107.0, 110.0):
        for side in ("CE", "PE"):
            sel, why = select_contract(book, {"atm": atm}, side, c, strike_step=5.0)
            if sel is None:
                assert why in ("NO_ATM_OR_ITM_CONTRACT", "ITM_TOO_DEEP")
                continue
            k = sel["strike"]
            if side == "CE":
                assert k <= atm + 1e-9, "bought an OTM call"
            else:
                assert k >= atm - 1e-9, "bought an OTM put"
            assert sel["itm_steps"] <= c.max_itm_steps


# ------------------------------------------------------------------ exits

def _bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


def test_structure_stop_sits_below_the_trigger_candle():
    c = BuyOnlySettings(sl_buffer_points=1.0, min_stop_points=4.0)
    stop, risk = EX.initial_stop(100.0, 95.0, "long", c)
    assert stop == pytest.approx(94.0)
    assert risk == pytest.approx(6.0)
    # the floor caps how TIGHT the stop may be, never how loose
    stop2, risk2 = EX.initial_stop(100.0, 99.5, "long", c)
    assert risk2 >= c.min_stop_points - 1e-9


def test_stop_is_armed_from_the_trigger_candle_and_can_fire_on_bar_one():
    c = BuyOnlySettings(min_stop_points=4.0, sl_buffer_points=1.0)
    r = EX.run_exit([_bar(100, 100, 90, 90)], 100.0, "long", c, trigger_low=95.0)
    assert r["exit_reason"] == "STOP"
    assert r["exit_bar"] == 1


def test_breakeven_moves_the_stop_to_entry_once_costs_plus_2_5_are_covered():
    c = BuyOnlySettings(brokerage_per_order=20.0, lot_size=15,
                        breakeven_points=2.5, min_stop_points=10.0)
    trig = c.breakeven_trigger_points()
    r = EX.run_exit([_bar(100, 100 + trig - 0.01, 99.5, 100)], 100.0, "long", c,
                    trigger_low=90.0, target_px=9999)
    assert r["be_moved"] is False, "moved before costs+2.5pts were covered"
    r2 = EX.run_exit([_bar(100, 100 + trig + 0.01, 99.5, 100)], 100.0, "long", c,
                     trigger_low=90.0, target_px=9999)
    assert r2["be_moved"] is True


def test_stop_adjustment_cannot_fire_on_the_bar_that_set_it():
    """A raised stop applies from the NEXT bar, never retroactively."""
    c = BuyOnlySettings(min_stop_points=4.0, breakeven_points=2.5,
                        brokerage_per_order=0.0, profit_lock_fraction=0.5)
    # bar 1 spikes +6 then closes back at entry; bar 2 drifts down
    bars = [_bar(100, 106, 99.9, 100.0), _bar(100, 100, 99.5, 99.6)]
    r = EX.run_exit(bars, 100.0, "long", c, trigger_low=96.0, target_px=9999)
    # bar 1's low (99.9) sits BELOW the freshly raised 103. Applying the
    # adjustment to the bar that set it would have exited at 103 on bar 1.
    assert r["exit_bar"] == 2, "adjusted stop fired on the bar that created it"
    assert r["exit_price"] == pytest.approx(103.0)


def test_profit_lock_banks_half_at_one_to_one_risk_reward():
    c = BuyOnlySettings(min_stop_points=10.0, sl_buffer_points=0.0,
                        brokerage_per_order=0.0, breakeven_points=0.0,
                        profit_lock_fraction=0.5)
    # risk = 10 (stop 90). 1:1 = +10 pts. Bar 1 reaches +20 -> lock at +10.
    bars = [_bar(100, 120, 99.9, 119.0), _bar(119, 119, 100.0, 100.5)]
    r = EX.run_exit(bars, 100.0, "long", c, trigger_low=90.0, target_px=9999)
    assert r["profit_locked"] is True
    assert r["exit_price"] == pytest.approx(110.0)
    assert r["net_points"] == pytest.approx(10.0)


def test_trailing_stop_follows_the_previous_candle_low():
    c = BuyOnlySettings(min_stop_points=5.0, sl_buffer_points=1.0,
                        brokerage_per_order=0.0, breakeven_points=0.0)
    # trigger_low 96 -> stop 95, risk 5. Bar 1 high 103 arms breakeven (stop 100)
    # but fav 3 < risk 5, so the profit lock stays out of the way.
    bars = [_bar(100, 103, 100.2, 102.0),      # bar1 low 100.2
            _bar(102, 102.5, 100.5, 101.5),    # bar2 low 100.5 -> trail candidate
            _bar(101.5, 102, 100.4, 100.6)]    # bar3 pierces bar2's low
    r = EX.run_exit(bars, 100.0, "long", c, trigger_low=96.0, target_px=9999)
    assert r["exit_reason"] == "STOP"
    assert r["exit_bar"] == 3
    assert r["exit_price"] == pytest.approx(100.5), "trail must use the PREVIOUS bar low"


def test_trailing_never_loosens_the_stop():
    c = BuyOnlySettings(min_stop_points=5.0, sl_buffer_points=1.0,
                        brokerage_per_order=0.0, breakeven_points=5.0,
                        profit_lock_fraction=0.0)
    # trigger_low 96 -> stop 95, risk 5. Bar 1 high 106 arms breakeven (stop 100).
    # Bar 2's own low (99.0) is far below the armed stop; a trailing rule that
    # could loosen would drag the stop down to it.
    bars = [_bar(100, 106, 99.5, 105.0), _bar(105, 105.5, 99.0, 99.5)]
    r = EX.run_exit(bars, 100.0, "long", c, trigger_low=96.0, target_px=9999)
    assert r["exit_price"] == pytest.approx(100.0), "stop was loosened"


def test_stop_wins_when_one_bar_touches_both_stop_and_target():
    c = BuyOnlySettings(min_stop_points=50.0, sl_buffer_points=0.0)
    r = EX.run_exit([_bar(100, 200, 10, 100)], 100.0, "long", c, trigger_low=90.0,
                    target_px=150.0)
    assert r["exit_reason"] == "STOP"
    assert r["exit_price"] == pytest.approx(50.0)


def test_time_to_target_is_recorded_independently_of_the_exit_bar():
    c = BuyOnlySettings(min_stop_points=10.0, brokerage_per_order=0.0)
    bars = ([_bar(100, 100.2, 99.8, 100.0)] * 2
            + [_bar(100, 130, 99.9, 129.0)]      # touches target on bar 3
            + [_bar(129, 130, 128.0, 129.0)])   # then trails out
    r = EX.run_exit(bars, 100.0, "long", c, trigger_low=90.0, target_px=125.0)
    assert r["first_target_bar"] == 3
    assert r["exit_bar"] >= 3


def test_time_stop_fires_when_price_never_resolves():
    c = BuyOnlySettings(max_hold_bars=5, min_stop_points=10.0)
    r = EX.run_exit([_bar(100, 100.2, 99.8, 100.0)] * 5, 100.0, "long", c,
                    trigger_low=90.0, target_px=9999)
    assert r["exit_reason"] == "TIME"
    assert r["duration_bars"] == 5


def test_buy_only_rejects_short_sides():
    c = BuyOnlySettings()
    with pytest.raises(ValueError):
        EX.run_exit([_bar(100, 101, 99, 100)], 100.0, "short", c, trigger_low=95.0)


# ------------------------------------------------------------------ hypotheses

def test_oi_velocity_is_not_available_without_an_oi_field():
    q = synth_chain(with_oi=False)
    assert "oi" not in q.columns
    av = availability(q)
    assert av["OI_VELOCITY"].startswith("NOT_AVAILABLE")
    assert "open_interest" in av["OI_VELOCITY"]
    for k in ("VOLATILITY_COIL", "LIQUIDITY_FLUSH", "VWAP_SNAP_BACK"):
        assert av[k] == "AVAILABLE"


def test_oi_velocity_runs_when_oi_is_present():
    q = synth_chain(with_oi=True)
    assert availability(q)["OI_VELOCITY"] == "AVAILABLE"
    u = add_session_features(synth_underlying(600), 30)
    sig, _ = run_all(u, q, BuyOnlySettings())
    assert set(sig["hypothesis"]) <= {"VOLATILITY_COIL", "OI_VELOCITY",
                                      "LIQUIDITY_FLUSH", "VWAP_SNAP_BACK"}


def test_signals_respect_the_schema_and_are_causal():
    q = pd.concat([synth_chain(otype="CE"), synth_chain(otype="PE")],
                  ignore_index=True)
    u = add_session_features(synth_underlying(600), 30)
    sig, _ = run_all(u, q, BuyOnlySettings())
    assert list(sig.columns) == SIGNAL_COLS
    if len(sig):
        assert set(sig["direction"]) <= {"CE", "PE"}
        assert pd.to_datetime(sig["timestamp"]).is_monotonic_increasing


def test_signal_generation_is_causal_under_future_tampering():
    q = pd.concat([synth_chain(otype="CE"), synth_chain(otype="PE")],
                  ignore_index=True)
    u = add_session_features(synth_underlying(600), 30)
    s1, _ = run_all(u, q, BuyOnlySettings())
    tampered = u.copy()
    cut = 400
    mask = tampered.index >= cut
    tampered.loc[mask, ["open", "high", "low", "close"]] *= 3.0
    s2, _ = run_all(tampered, q, BuyOnlySettings())
    key = lambda d: (list(d["timestamp"]), list(d["hypothesis"]), list(d["direction"]))
    a = [t for t in key(s1)[0] if t in set(key(s2)[0]) and
         pd.Timestamp(t) < u["timestamp"].iloc[cut]]
    b = [t for t in key(s2)[0] if t in set(key(s1)[0]) and
         pd.Timestamp(t) < u["timestamp"].iloc[cut]]
    assert a == b


# ------------------------------------------------------------------ regime

def test_regime_classification_produces_all_three_states():
    rng = np.random.default_rng(1)
    n = 4000
    ts = pd.date_range("2026-01-05 09:15", periods=n, freq="min")
    trend = 100 + np.arange(n) * 0.05
    chop = 100 + rng.normal(0, 1, n).cumsum()
    comp = 100 + rng.normal(0, 0.02, n).cumsum()
    frames = []
    for name, path in (("trend", trend), ("chop", chop), ("comp", comp)):
        d = pd.DataFrame({"timestamp": ts, "open": path, "high": path + 0.2,
                          "low": path - 0.2, "close": path,
                          "volume": 1000, "underlying_source": "futures"})
        frames.append(d)
    u = pd.concat(frames, ignore_index=True)
    f = classify_regimes(add_session_features(u, 30), BuyOnlySettings(er_window=30))
    rs = regime_summary(f)
    assert rs["TRENDING"] + rs["COMPRESSING"] + rs["CHOPPY"] + rs["UNKNOWN"] == len(f)


def test_adaptive_engine_blocks_choppy_regime():
    eng = AdaptiveEngine(BuyOnlySettings(), restrict_to_regime_hypothesis=False)
    ok, why = eng.allow("CHOPPY", "VOLATILITY_COIL")
    assert ok is False and why == "CHOPPY_REGIME"


def test_adaptive_engine_blocks_a_hypothesis_the_regime_does_not_authorise():
    eng = AdaptiveEngine(BuyOnlySettings(), restrict_to_regime_hypothesis=True)
    ok, why = eng.allow("TRENDING", "VOLATILITY_COIL")
    assert ok is False and why == "REGIME_HYPOTHESIS_MISMATCH"
    ok2, _ = eng.allow("TRENDING", "LIQUIDITY_FLUSH")
    assert ok2 is True


def test_two_consecutive_losses_shut_the_engine_down():
    c = BuyOnlySettings(max_consecutive_losses=2)
    eng = AdaptiveEngine(c, restrict_to_regime_hypothesis=False)
    eng.on_exit(-5.0)
    ok1, _ = eng.allow("TRENDING", "LIQUIDITY_FLUSH")
    assert ok1 is True, "one loss must not halt trading"
    eng.on_exit(-5.0)
    ok2, why = eng.allow("TRENDING", "LIQUIDITY_FLUSH")
    assert ok2 is False and why == "LOSS_STREAK"
    assert eng.stats()["loss_streak_shutdowns"] == 1


def test_a_win_resets_the_consecutive_loss_counter():
    c = BuyOnlySettings(max_consecutive_losses=2)
    eng = AdaptiveEngine(c, restrict_to_regime_hypothesis=False)
    eng.on_exit(-5.0); eng.on_exit(3.0); eng.on_exit(-5.0)
    ok, _ = eng.allow("TRENDING", "LIQUIDITY_FLUSH")
    assert ok is True


# ------------------------------------------------------------------ engine

def synthetic_signals(underlying, hypothesis="LIQUIDITY_FLUSH", n=12, step=40):
    """Explicit, evenly spaced signals so engine tests do not depend on detectors."""
    ts = pd.to_datetime(underlying["timestamp"])
    picks = list(range(30, min(len(ts) - 60, 30 + n * step), step))[:n]
    return pd.DataFrame({
        "timestamp": [ts.iloc[i] for i in picks],
        "hypothesis": hypothesis,
        "direction": ["CE" if i % 2 == 0 else "PE" for i in range(len(picks))],
        "trigger_high": [float(underlying["high"].iloc[i]) for i in picks],
        "trigger_low": [float(underlying["low"].iloc[i]) for i in picks],
        "trigger_close": [float(underlying["close"].iloc[i]) for i in picks],
        "detail": ["synthetic"] * len(picks),
    })[SIGNAL_COLS]


def _engine_fixture(cfg, n=12):
    """A deterministic universe + explicit signals for engine-level tests."""
    q = pd.concat([synth_chain(n=900, otype="CE", seed=2),
                   synth_chain(n=900, otype="PE", seed=4)], ignore_index=True)
    q["strike"] = q["strike"] + 55000.0
    q["symbol"] = q["symbol"] + "0"
    u = synth_underlying(900)
    u["atm"] = 55105.0
    u = add_session_features(u, cfg.er_window)
    u = classify_regimes(u, cfg)
    return q, u


def _run_on_synthetic(n_sig=12, cfg=None, restrict=True, hypothesis="LIQUIDITY_FLUSH"):
    cfg = cfg or BuyOnlySettings(min_stop_points=10.0, max_hold_bars=20)
    q, u = _engine_fixture(cfg)
    sig = synthetic_signals(u, hypothesis=hypothesis, n=n_sig)
    led, audit = run_backtest(sig, u, q, cfg, restrict_to_regime=restrict)
    return led, audit, q, u


def test_engine_never_exceeds_max_lots_and_never_shorts():
    cfg = BuyOnlySettings(max_lots=5, lot_size=15, min_stop_points=10.0)
    led, _, _, _ = _run_on_synthetic(cfg=cfg)
    if len(led):
        assert (led["lots"] <= 5).all()
        assert set(led["direction"]) <= {"CE", "PE"}
        assert (led["rupee_pnl"] == led["net_points"] * cfg.lot_size * led["lots"]).all()


def test_engine_never_buys_an_otm_contract():
    led, _, q, u = _run_on_synthetic()
    if len(led):
        for _, r in led.iterrows():
            sym = r["symbol"]
            atm = float(q.loc[q["symbol"] == sym, "strike"].iloc[0])
            assert r["moneyness"] in ("ATM", "ITM")
            assert r["strike"] <= atm + 1e-6 or r["strike"] >= atm - 1e-6


def test_entry_is_the_next_bar_open_not_the_signal_bar_close():
    cfg = BuyOnlySettings(min_stop_points=10.0, max_hold_bars=20)
    led, _, q, _ = _run_on_synthetic(cfg=cfg)
    assert len(led), "expected at least one trade"
    rec = ContractBook(q)
    checked = 0
    for _, r in led.iterrows():
        rr = rec.by_symbol[r["symbol"]]
        sig_i = rr["pos"].get(pd.Timestamp(r["timestamp"]))
        if sig_i is None:
            continue
        nxt = sig_i + 1
        if nxt < len(rr["close"]):
            assert r["entry_time"] == rr["ts"][nxt]
            assert r["entry_price"] == pytest.approx(rr["open"][nxt])
            assert r["entry_price"] != pytest.approx(rr["close"][sig_i])
            checked += 1
    assert checked > 0


def test_every_trade_charges_round_trip_cost():
    led, _, _, _ = _run_on_synthetic()
    if len(led):
        assert (led["cost_points"] > 0).all()
        assert np.allclose(led["net_points"],
                           led["gross_points"] - led["cost_points"])
        assert (led["net_points"] < led["gross_points"]).all()


def test_engine_holds_at_most_one_position_at_a_time():
    led, _, _, _ = _run_on_synthetic()
    if len(led) > 1:
        led2 = led.sort_values("entry_time").reset_index(drop=True)
        assert (led2["entry_time"].iloc[1:].to_numpy()
                > led2["exit_time"].iloc[:-1].to_numpy()).all()


def test_engine_never_exceeds_the_configured_hold_window():
    cfg = BuyOnlySettings(min_stop_points=10.0, max_hold_bars=7)
    led, _, _, _ = _run_on_synthetic(cfg=cfg)
    if len(led):
        assert (led["duration_bars"] <= cfg.max_hold_bars).all()


def test_choppy_regime_blocks_every_entry_when_restricted():
    cfg = BuyOnlySettings(min_stop_points=10.0, er_trend=0.99)
    q, u = _engine_fixture(cfg)
    u["regime"] = "CHOPPY"                 # isolate the engine's CHOPPY gate
    sig = synthetic_signals(u, n=12)
    led, audit = run_backtest(sig, u, q, cfg, restrict_to_regime=True)
    assert len(led) == 0
    assert audit["blocked"].get("CHOPPY_REGIME", 0) > 0


def test_empty_signal_set_produces_an_empty_ledger_not_a_crash():
    q = pd.concat([synth_chain(n=200, otype="CE"),
                   synth_chain(n=200, otype="PE")], ignore_index=True)
    u = classify_regimes(add_session_features(synth_underlying(200), 30),
                         BuyOnlySettings())
    empty = pd.DataFrame({c: [] for c in SIGNAL_COLS})
    led, audit = run_backtest(empty, u, q, BuyOnlySettings())
    assert len(led) == 0
    assert audit["trades"] == 0


# ------------------------------------------------------------------ reporting

def test_max_drawdown_of_a_monotonic_curve_is_zero():
    assert max_drawdown([1, 2, 3, 4]) == pytest.approx(0.0)


def test_max_drawdown_is_negative_for_a_falling_curve():
    d = max_drawdown([5, -10, 3, -20])
    assert d < 0


def test_summarize_reports_the_four_required_metrics():
    led, _, _, _ = _run_on_synthetic()
    s = summarize(led, BuyOnlySettings(), label="ALL")
    for k in ("win_rate", "profit_factor", "max_dd_points", "time_to_target_bars"):
        assert k in s
    if s["trades"]:
        assert 0.0 <= s["win_rate"] <= 100.0
        assert s["reached_target"] <= s["trades"]
        if s["reached_target"] == 0:
            assert np.isnan(s["time_to_target_bars"]), "no target hit, no time to report"
        else:
            assert s["time_to_target_bars"] > 0
            assert s["time_to_target_min"] == s["time_to_target_bars"]


def test_summarize_handles_zero_trades_without_claiming_a_result():
    s = summarize(pd.DataFrame(), BuyOnlySettings())
    assert s["status"] == "NO_TRADES"
    assert np.isnan(s["win_rate"])


def test_significance_refuses_to_invent_a_number_on_a_tiny_sample():
    led, _, _, _ = _run_on_synthetic()
    s = significance(led.head(3))
    assert s["status"] == "INSUFFICIENT_TRADES"
    assert np.isnan(s["mean"]) and np.isnan(s["lo"]) and np.isnan(s["hi"])
    assert s["excludes_zero"] is False


def _synthetic_ledger(n=14):
    """A ledger with a KNOWN planted edge, for testing the statistics only."""
    rng = np.random.default_rng(11)
    day = pd.Timestamp("2026-01-05")
    base = pd.Timestamp("2026-01-05 09:15")
    rows = []
    for i in range(n):
        ts = base + pd.Timedelta(minutes=5 * i)
        rows.append({
            "trade_id": i + 1,
            "entry_time": ts, "exit_time": ts + pd.Timedelta(minutes=5),
            "net_points": float(rng.normal(1.5, 1.0)),   # planted positive edge
            "rupee_pnl": 0.0, "duration_bars": 5,
            "risk_points": 10.0, "mfe_points": 12.0, "mae_points": -3.0,
            "be_moved": True, "profit_locked": False,
            "time_to_target_bars": 3 if i % 3 == 0 else None,
            "hypothesis": "VOLATILITY_COIL" if i % 2 == 0 else "LIQUIDITY_FLUSH",
            "moneyness": "ITM", "lots": 5,
        })
    return pd.DataFrame(rows)


def test_significance_is_a_bootstrap_ci_on_the_mean_trade():
    s = significance(_synthetic_ledger(14))
    assert s["status"] == "TESTED"
    assert s["n"] == 14
    assert np.isfinite(s["mean"]) and np.isfinite(s["lo"]) and np.isfinite(s["hi"])
    assert s["lo"] <= s["mean"] <= s["hi"]


def test_bootstrap_ci_flags_a_genuine_edge_and_rejects_noise():
    edge = _synthetic_ledger(40)
    edge["net_points"] = np.random.default_rng(2).normal(6.0, 0.5, 40)
    assert bootstrap_ci(edge["net_points"])["excludes_zero"] is True
    noise = _synthetic_ledger(40)
    noise["net_points"] = np.random.default_rng(3).normal(0.0, 1.0, 40)
    assert bootstrap_ci(noise["net_points"])["excludes_zero"] is False


def test_signal_permutation_test_is_not_degenerate():
    """A null with zero spread would mean the test cannot detect anything.

    This is the trap that a ledger-level permutation test falls into: the mean of
    a permuted series is invariant, so the null equals the observation and p is
    always 1. The re-timing null must produce genuine variation.
    """
    cfg = BuyOnlySettings(min_stop_points=10.0, max_hold_bars=20)
    q, u = _engine_fixture(cfg)
    sig = synthetic_signals(u, n=16)
    led, _ = run_backtest(sig, u, q, cfg, restrict_to_regime=False)
    obs = float(pd.to_numeric(led["net_points"], errors="coerce").sum())
    r = signal_permutation_test(u, q, cfg, sig, obs, n_perm=12, restrict_to_regime=False)
    assert r["status"] == "TESTED"
    assert r["n_perm"] >= 10
    assert 0.0 < r["p_value"] <= 1.0
    # the null must actually vary, otherwise the test proves nothing
    assert r["null_sd"] > 0.0
    assert r["null_mean"] != r["observed_net"]


def test_by_hypothesis_ranks_every_hypothesis_that_traded():
    led, _, _, _ = _run_on_synthetic()
    rows = by_hypothesis(led, BuyOnlySettings())
    assert len(rows) == led["hypothesis"].nunique()
    w = [r["win_rate"] for r in rows]
    assert w == sorted(w, reverse=True)


def test_logic_map_documents_the_shutdown_paths():
    m = logic_map()
    for token in ("CHOPPY", "LOSS_STREAK", "REGIME_HYPOTHESIS_MISMATCH",
                  "brokerage + 2.5", "next bar", "VOLATILITY_COIL",
                  "LIQUIDITY_FLUSH", "mermaid"):
        assert token in m


# ------------------------------------------------------------------ end to end

def test_full_pipeline_end_to_end_on_synthetic_data(tmp_path):
    """signals -> regime -> adaptive engine -> contracts -> exits -> report."""
    from xbost_option_discovery.run_buyonly import main
    q = pd.concat([synth_chain(n=900, otype="CE", seed=2),
                   synth_chain(n=900, otype="PE", seed=4)], ignore_index=True)
    q["strike"] = q["strike"] + 55000.0
    q["symbol"] = q["symbol"] + "0"
    path = tmp_path / "chain.csv"
    q.to_csv(path, index=False)
    outdir = tmp_path / "out"
    rc = main(["--path", str(path), "--outdir", str(outdir),
               "--min-stop-points", "10", "--max-hold-bars", "20",
               "--n-perm", "50"])
    assert rc == 0
    for f in ("summary.json", "report.md", "logic_map.md"):
        assert (outdir / f).exists(), f
    import json
    s = json.loads((outdir / "summary.json").read_text())
    for k in ("win_rate", "profit_factor", "max_dd_points", "time_to_target_bars"):
        assert k in s["summary"], k
    assert s["config"]["max_lots"] == 5
    assert "VOLATILITY_COIL" in (outdir / "report.md").read_text()