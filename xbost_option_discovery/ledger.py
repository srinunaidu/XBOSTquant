"""Canonical trade ledger (§30). Every candidate generates exactly one ledger;
all downstream metrics derive from it. Ledger + exit-config hashes included."""
import hashlib
import pandas as pd


LEDGER_COLUMNS = ["trade_id", "event_id", "cluster_id", "candidate_id", "contract",
                  "expiry", "strike", "option_type", "direction",
                  "entry_timestamp", "exit_timestamp", "entry_price", "exit_price",
                  "exit_reason", "gross_pnl", "cost", "net_pnl", "ret",
                  "mae", "mfe", "holding_time",
                  "sl_config", "tp_config", "trail_config", "exit_model",
                  "initial_sl", "initial_tp", "CONFIG_FINGERPRINT", "model"]


def finalize_ledger(rows, cid, sl, tp, trail, exit_mode, hold_bars, cost_per_trade=0.0):
    from .backtest import fingerprint
    fp = fingerprint(cid, sl, tp, trail, exit_mode, hold_bars)
    out = []
    for i, r in enumerate(rows):
        gross = r["ret"]
        out.append({
            "trade_id": f"{cid}#{i}", "event_id": r.get("event_id", i),
            "cluster_id": r.get("cluster_id", -1), "candidate_id": cid,
            "contract": r.get("contract", f"{r.get('strike')}_{r.get('option_type')}"),
            "expiry": r.get("expiry", "UNKNOWN"), "strike": r.get("strike"),
            "option_type": r.get("option_type"), "direction": r.get("direction", "long"),
            "entry_timestamp": r["entry_time"], "exit_timestamp": r["exit_time"],
            "entry_price": r["entry_price"], "exit_price": r["exit_price"],
            "exit_reason": r["exit_reason"], "gross_pnl": gross, "cost": cost_per_trade,
            "net_pnl": gross - cost_per_trade, "ret": gross - cost_per_trade,
            "mae": r.get("mae"), "mfe": r.get("mfe"),
            "holding_time": r.get("duration_bars", 0),
            "sl_config": sl, "tp_config": tp, "trail_config": trail,
            "exit_model": exit_mode, "initial_sl": r.get("initial_sl"),
            "initial_tp": r.get("initial_tp"), "CONFIG_FINGERPRINT": fp,
            "model": "RESEARCH_PRICE_MODEL",
        })
    led = pd.DataFrame(out, columns=LEDGER_COLUMNS)
    return led


def ledger_hash(ledger) -> str:
    if ledger is None or len(ledger) == 0:
        return "EMPTY"
    import hashlib
    h = hashlib.sha256(pd.util.hash_pandas_object(ledger, index=True).values.tobytes())
    return h.hexdigest()[:16]


def exit_config_hash(sl, tp, trail, exit_mode, hold_bars) -> str:
    import hashlib
    s = f"{sl}|{tp}|{trail}|{exit_mode}|{hold_bars}"
    return hashlib.sha256(s.encode()).hexdigest()[:16]
