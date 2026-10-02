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
    base = base.sort_values(["symbol", "timestamp"])
    fp = fingerprint(cid, sl, tp, trail, exit_mode, hold_bars)
    # per-contract forward bars lookup
    feat_s = feat.sort_values(["symbol", "timestamp"])
    grp = {k: g.set_index("timestamp").sort_index()
           for k, g in feat_s.groupby("symbol")}
    rows = []
    skipped = {"nan_entry": 0, "zero_entry": 0, "nan_exit": 0}
    for _, sig in base.iterrows():
        key = sig["symbol"] if "symbol" in sig else (sig["strike"], sig["option_type"])
        g = grp.get(key)
        entry_t = sig["timestamp"]
        try:
            entry = float(sig["close"])
        except (TypeError, ValueError):
            entry = float("nan")
        if not np.isfinite(entry):
            skipped["nan_entry"] += 1
            continue
        if not entry > 0:
            skipped["zero_entry"] += 1
            continue
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
            skipped["nan_exit"] += 1
            continue
        exit_px, reason, dur = float("nan"), "TIME", len(window)
        last_close = pd.to_numeric(window["close"], errors="coerce")
        if last_close.notna().any():
            exit_px = float(last_close.dropna().iloc[-1])
        peak, trough = entry, entry
        trail_hit = False
        for i, (_, b) in enumerate(window.iterrows(), start=1):
            try:
                hi, lo = float(b["high"]), float(b["low"])
            except (TypeError, ValueError):
                hi, lo = float("nan"), float("nan")
            if np.isfinite(hi) and hi > peak:
                peak = hi
            if np.isfinite(lo) and lo < trough:
                trough = lo
            if direction == "long":
                hit_sl = np.isfinite(lo) and lo <= sl_px
                hit_tp = np.isfinite(hi) and hi >= tp_px
            else:
                hit_sl = np.isfinite(hi) and hi >= sl_px
                hit_tp = np.isfinite(lo) and lo <= tp_px
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
                    try:
                        bc = float(b["close"])
                    except (TypeError, ValueError):
                        bc = float("nan")
                    cur = ((bc - entry) / entry * 100 if direction == "long"
                           else (entry - bc) / entry * 100) if np.isfinite(bc) else float("nan")
                    if np.isfinite(cur) and cur <= fav - trail * 0.5:
                        exit_px, reason, dur = bc, "TRAIL", i
                        break
        if not np.isfinite(exit_px) or not exit_px > 0:
            skipped["nan_exit"] += 1
            continue
        ret = (exit_px / entry * 100 - 100) if direction == "long" else (entry / exit_px * 100 - 100)
        mae = (entry - trough) / entry * 100 if direction == "long" else (peak - entry) / entry * 100
        mfe = (peak - entry) / entry * 100 if direction == "long" else (entry - trough) / entry * 100
        rows.append({"trade_id": f"{cid}#{len(rows)}",
                     "event_id": len(rows), "cluster_id": -1,
                     "candidate_id": cid,
                     "contract": f"{sig.get('strike')}_{sig.get('option_type')}",
                     "expiry": sig.get("expiry", "UNKNOWN"),
                     "strike": sig.get("strike"), "option_type": sig.get("option_type"),
                     "direction": direction,
                     "entry_time": entry_t, "entry_timestamp": entry_t,
                     "exit_time": window.index[dur - 1], "exit_timestamp": window.index[dur - 1],
                     "entry_price": entry, "exit_price": exit_px, "exit_reason": reason,
                     "ret": ret, "gross_pnl": ret, "cost": 0.0, "net_pnl": ret,
                     "mae": mae, "mfe": mfe, "duration_bars": dur,
                     "holding_time": dur,
                     "sl_config": sl, "tp_config": tp, "trail_config": trail,
                     "exit_model": exit_mode, "initial_sl": sl_px, "initial_tp": tp_px,
                     "CONFIG_FINGERPRINT": fp, "model": "RESEARCH_PRICE_MODEL"})
    from .ledger import ledger_hash, exit_config_hash
    ledger = pd.DataFrame(rows)
    if verify and len(ledger):
        assert (ledger["CONFIG_FINGERPRINT"] == fp).all(), "fingerprint did not reach ledger"
        assert set(["sl_config", "tp_config", "exit_reason", "ret"]).issubset(ledger.columns)
    if len(ledger):
        ledger.attrs["TRADE_LEDGER_HASH"] = ledger_hash(ledger)
        ledger.attrs["EXIT_CONFIG_HASH"] = exit_config_hash(sl, tp, trail, exit_mode, hold_bars)
    ledger.attrs["SKIPPED"] = skipped
    return ledger

def pnl_diagnostic(*ledgers):
    """P&L_AUDIT over gate ledgers: finite accounting, first NaN trades."""
    tot = fin = 0
    first_nan = []
    for led in ledgers:
        for _, t in led.iterrows():
            tot += 1
            r = t.get("ret")
            try:
                ok = np.isfinite(float(r))
            except (TypeError, ValueError):
                ok = False
            if ok:
                fin += 1
            elif len(first_nan) < 10:
                first_nan.append({
                    "trade_id": t.get("trade_id"), "timestamp": str(t.get("entry_time")),
                    "contract": t.get("contract"), "entry_price": t.get("entry_price"),
                    "exit_price": t.get("exit_price"), "exit_reason": t.get("exit_reason"),
                    "pnl": r,
                    "NaN_reason": ("NaN entry" if not _finite(t.get("entry_price"))
                                   else "NaN exit" if not _finite(t.get("exit_price")) else "NaN ret"),
                })
    return {"total_trades": tot, "finite_entry": None, "finite_exit": None,
            "finite_pnl": fin, "nan_pnl": tot - fin,
            "status": "PASS" if tot - fin == 0 else "FAIL", "first_nan_trade": first_nan}

def _finite(x):
    try:
        return np.isfinite(float(x)) and float(x) > 0
    except (TypeError, ValueError):
        return False

def propagation_gate(feat, mask, sl=0.5, hold_bars=5):
    """TEST_A/B/C: same entries, TP=1/2/3. Structure + metric verdicts."""
    res = {}
    for tp, name in [(1.0, "TEST_A"), (2.0, "TEST_B"), (3.0, "TEST_C")]:
        led = backtest(feat, mask, hold_bars=hold_bars, sl=sl, tp=tp,
                       exit_mode="premium", cid=name, verify=True)
        res[name] = led
    finite = {k: pd.to_numeric(v["ret"], errors="coerce").dropna() for k, v in res.items()}
    pa = float(finite["TEST_A"].sum()) if len(res["TEST_A"]) else 0.0
    pb = float(finite["TEST_B"].sum()) if len(res["TEST_B"]) else 0.0
    pc = float(finite["TEST_C"].sum()) if len(res["TEST_C"]) else 0.0
    identical = (len(res["TEST_A"]) and res["TEST_A"]["ret"].equals(res["TEST_B"]["ret"])
                 and res["TEST_B"]["ret"].equals(res["TEST_C"]["ret"]))
    # reachable check: did any path attain TP1?
    reached = bool(((res["TEST_A"]["exit_reason"] == "TP").any() or (res["TEST_B"]["exit_reason"] == "TP").any())) if len(res["TEST_A"]) else False
    struct = not identical
    metric = all(len(v) == 0 or len(finite[k]) == len(v) for k, v in res.items())
    if identical and reached:
        status = "FAIL"
    elif not struct:
        status = "PASS"  # unreachable TPs: identical-by-construction + reason logged by caller
    elif not metric:
        status = "PASS_STRUCTURE_FAIL_METRIC"
    else:
        status = "PASS"
    if len(res["TEST_A"]) == 0:
        status = "FAIL"
    return {"EXIT_PARAMETER_PROPAGATION": status, "pnl": {"A": pa, "B": pb, "C": pc},
            "identical": bool(identical), "tp_reached": reached, "ledgers": res,
            "finite_rate": {k: (len(finite[k]) / len(v) if len(v) else 1.0) for k, v in res.items()}}
