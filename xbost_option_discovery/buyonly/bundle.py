"""UI bundle: one self-contained JSON document for the Buy Only tab.

The tab never recomputes anything. It renders exactly what the Python engine
measured, which is deliberate: a browser-side reimplementation of a statistically
careful engine is how two code paths silently start disagreeing. Every number on
screen therefore traces to this file, and the log travels with it so a reviewer can
see the run that produced the numbers next to the numbers themselves.
"""
import numpy as np
import pandas as pd

from .report import logic_map


def _clean(obj):
    """Make a structure JSON-safe (NaN/Inf -> None, numpy scalars -> python)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        return f if np.isfinite(f) else None
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    return obj


def build_bundle(cfg, summary, per_hypothesis, significance, timing, sensitivity,
                 audit, regimes, availability, moneyness, underlying_source,
                 signals, ledger, log_lines, run_id, dataset_info, wall_ms):
    """Assemble the full bundle consumed by web/src/pages/BuyOnly.tsx."""
    sig_rows = []
    if signals is not None and len(signals):
        s = signals.copy()
        s["timestamp"] = pd.to_datetime(s["timestamp"]).dt.strftime("%Y-%m-%dT%H:%M:%S")
        sig_rows = _clean(s.to_dict(orient="records"))

    led_rows = []
    if ledger is not None and len(ledger):
        l = ledger.copy()
        for c in ("timestamp", "entry_time", "exit_time"):
            if c in l.columns:
                l[c] = pd.to_datetime(l[c]).dt.strftime("%Y-%m-%dT%H:%M:%S")
        led_rows = _clean(l.to_dict(orient="records"))

    blocked_detail = {}
    if audit:
        blocked_detail = _clean(audit.get("blocked", {}))

    return _clean({
        "run_id": run_id,
        "wall_ms": wall_ms,
        "dataset": dataset_info,
        "settings": cfg.to_dict(),
        "config_fingerprint": cfg.fingerprint(),
        "constraints": {
            "long_only": True,
            "universe": "ATM and ITM only",
            "max_lots": cfg.max_lots,
            "lot_size": cfg.lot_size,
            "breakeven_points": cfg.breakeven_points,
            "brokerage_points": round(cfg.brokerage_points(), 4),
            "breakeven_trigger_points": round(cfg.breakeven_trigger_points(), 4),
            "no_indicators": "no RSI, no MACD, no moving-average crossover",
            "costs_charged": True,
        },
        "regimes": regimes,
        "availability": availability,
        "moneyness": moneyness,
        "underlying_source": underlying_source,
        "summary": summary,
        "by_hypothesis": per_hypothesis,
        "significance": significance,
        "timing_test": timing,
        "sensitivity": sensitivity,
        "audit": {
            "signals_in": (audit or {}).get("signals_in", 0),
            "trades": (audit or {}).get("trades", 0),
            "blocked": blocked_detail,
            "engine": _clean((audit or {}).get("engine", {})),
            "skipped_no_contract": (audit or {}).get("skipped_no_contract", 0),
            "skipped_no_entry_bar": (audit or {}).get("skipped_no_entry_bar", 0),
            "skipped_bad_price": (audit or {}).get("skipped_bad_price", 0),
        },
        "signals": sig_rows,
        "ledger": led_rows,
        "logic_map": logic_map(),
        "log": list(log_lines or []),
    })