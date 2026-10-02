"""Option-native backtest (§19/20/21/28/30) with OHLC path exits + immutable CONFIG_FINGERPRINT (§19).
RESEARCH_PRICE_MODEL (DISCOVERY_COST_MODE=ZERO). Not executable (no bid/ask).
"""
import pandas as pd
import numpy as np

def fingerprint(cid, sl, tp, trail, exit_mode, hold_bars=5):
    return (f"candidate_id={cid}|sl={sl}|tp={tp}|trail={trail}|exit_mode={exit_mode}"
            f"|hold={hold_bars}|cost=ZERO|model=RESEARCH")

def backtest(feat, mask, hold_bars=5, sl=0.5, tp=1.0, trail=None, exit_mode="premium",
             cid="CAND", direction="long", verify=True):
    """Path-dependent exits on 1m OHLC *after* entry bar. Long: SL on low, TP on high.
    Same entries + different TP must diverge when path reaches the level (TEST_A/B/C)."""
    base = feat.loc[mask.fillna(False)].copy()
    if len(base) == 0:
        cols = ["candidate_id", "entry_time", "exit_time", "entry_price", "exit_price",
                "exit_reason", "ret", "mae", "mfe", "duration_bars",
                "sl_config", "tp_config", "trail_config", "exit_model",
                "initial_sl", "initial_tp", "CONFIG_FINGERPRINT", "model"]
        return pd.DataFrame({c: [] for c in cols})
    base = base.sort_values(["strike", "option_type", "timestamp"])
    fp = fingerprint(cid, sl, tp, trail, exit_mode, hold_bars)
    # per-contract forward bars lookup
    feat_s = feat.sort_values(["strike", "option_type", "timestamp"])
    grp = {k: g.set_index("timestamp").sort_index()
           for k, g in feat_s.groupby(["strike", "option_type"])}
    rows = []
    for _, sig in base.iterrows():
        key = (sig["strike"], sig["option_type"])
        g = grp.get(key)
        entry_t = sig["timestamp"]; entry = float(sig["close"])
        if direction == "long":
            sl_px = entry * (1 - sl / 100); tp_px = entry * (1 + tp / 100)
        else:
            sl_px = entry * (1 + sl / 100); tp_px = entry * (1 - tp / 100)
        # forward window strictly after entry
        try:
            pos = g.index.get_loc(entry_t)
            if isinstance(pos, slice):
                pos = pos.start
        except KeyError:
            continue
        window = g.iloc[pos + 1:pos + 1 + hold_bars]
        if len(window) == 0:
            continue
        exit_px, reason, dur = float(window.iloc[-1]["close"]), "TIME", len(window)
        peak, trough = entry, entry
        trail_hit = False
        for i, (_, b) in enumerate(window.iterrows(), start=1):
            hi, lo = float(b["high"]), float(b["low"])
            peak = max(peak, hi); trough = min(trough, lo)
            hit_sl = (lo <= sl_px) if direction == "long" else (hi >= sl_px)
            hit_tp = (hi >= tp_px) if direction == "long" else (lo <= tp_px)
            if hit_sl and hit_tp:
                exit_px, reason, dur = sl_px, "SL", i  # conservative: SL first
                break
            if hit_sl:
                exit_px, reason, dur = sl_px, "SL", i
                break
            if hit_tp:
                exit_px, reason, dur = tp_px, "TP", i
                break
            if trail is not None:
                fav = (peak - entry) / entry * 100 if direction == "long" else (entry - trough) / entry * 100
                if fav >= trail:
                    cur = (float(b["close"]) - entry) / entry * 100 if direction == "long" else (entry - float(b["close"])) / entry * 100
                    if cur <= fav - trail * 0.5:
                        exit_px, reason, dur = float(b["close"]), "TRAIL", i
                        break
        ret = (exit_px / entry * 100 - 100) if direction == "long" else (entry / exit_px * 100 - 100)
        mae = (entry - trough) / entry * 100 if direction == "long" else (peak - entry) / entry * 100
        mfe = (peak - entry) / entry * 100 if direction == "long" else (entry - trough) / entry * 100
        rows.append({"candidate_id": cid, "entry_time": entry_t,
                     "exit_time": window.index[dur - 1], "entry_price": entry,
                     "exit_price": exit_px, "exit_reason": reason, "ret": ret,
                     "mae": mae, "mfe": mfe, "duration_bars": dur,
                     "sl_config": sl, "tp_config": tp, "trail_config": trail,
                     "exit_model": exit_mode, "initial_sl": sl_px, "initial_tp": tp_px,
                     "CONFIG_FINGERPRINT": fp, "model": "RESEARCH_PRICE_MODEL"})
    ledger = pd.DataFrame(rows)
    if verify and len(ledger):
        assert (ledger["CONFIG_FINGERPRINT"] == fp).all(), "fingerprint did not reach ledger"
        assert set(["sl_config", "tp_config", "exit_reason", "ret"]).issubset(ledger.columns)
    return ledger

def propagation_gate(feat, mask, sl=0.5, hold_bars=5):
    """TEST_A/B/C (§20): same entries, TP=1/2/3. Must diverge when reachable."""
    res = {}
    for tp, name in [(1.0, "TEST_A"), (2.0, "TEST_B"), (3.0, "TEST_C")]:
        led = backtest(feat, mask, hold_bars=hold_bars, sl=sl, tp=tp,
                       exit_mode="premium", cid=name, verify=True)
        res[name] = led
    pa = res["TEST_A"]["ret"].sum() if len(res["TEST_A"]) else 0.0
    pb = res["TEST_B"]["ret"].sum() if len(res["TEST_B"]) else 0.0
    pc = res["TEST_C"]["ret"].sum() if len(res["TEST_C"]) else 0.0
    identical = (len(res["TEST_A"]) and res["TEST_A"]["ret"].equals(res["TEST_B"]["ret"])
                 and res["TEST_B"]["ret"].equals(res["TEST_C"]["ret"]))
    # reachable check: did any path attain TP1?
    reached = bool(((res["TEST_A"]["exit_reason"] == "TP").any() or (res["TEST_B"]["exit_reason"] == "TP").any())) if len(res["TEST_A"]) else False
    status = "FAIL" if (identical and reached) else "PASS"
    if len(res["TEST_A"]) == 0:
        status = "FAIL"
    return {"EXIT_PARAMETER_PROPAGATION": status, "pnl": {"A": pa, "B": pb, "C": pc},
            "identical": bool(identical), "tp_reached": reached, "ledgers": res}
