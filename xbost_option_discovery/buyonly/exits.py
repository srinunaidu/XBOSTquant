"""Exit architecture for the buy-only engine.

Four ordered rules, evaluated bar by bar on the OPTION's own 1m OHLC path
(never the underlying):

  1. Initial SL   - the trigger candle's structure: below the entry bar's low
                    (long option) minus a buffer, floored at `min_stop_points`
                    so risk is never trivially small.
  2. Breakeven    - once unrealised profit reaches brokerage + 2.5 points, the
                    stop moves to entry. The stop can then only exit flat, never
                    at a loss.
  3. Profit lock  - at 1:1 reward:risk (profit >= initial risk), the stop moves
                    to entry + 50% of the profit achieved so far, banking half.
  4. Trailing     - the stop follows the previous 1-minute candle's low (long
                    option), so the exit tightens with the structure rather than
                    with a fixed offset.

Conservative tie-break: when a single bar touches both the stop and the target,
the STOP wins. Assuming the favourable leg fills would inflate the win rate, and
win rate is the entire objective here.

`first_target_bar` is recorded separately from the exit bar so "time to target"
measures how long the setup actually took to reach the profit objective, which
can differ from how long the position was held.
"""
import numpy as np


def initial_stop(entry_px, bar_low, side, cfg):
    """Structure-based initial stop.

    side: 'long' for a bought option (both CE and PE buys are long premium).
    Returns (stop_px, risk_points).
    """
    buf = float(cfg.sl_buffer_points)
    floor = float(cfg.min_stop_points)
    if side != "long":
        raise ValueError("buy-only engine supports long premium only")
    raw = float(bar_low) - buf
    stop = min(raw, entry_px - floor)      # never closer than min_stop_points
    stop = min(stop, entry_px - 0.5)       # and never at/above entry
    risk = entry_px - stop
    if not np.isfinite(risk) or risk <= 0:
        stop = entry_px - floor
        risk = floor
    return float(stop), float(risk)


def run_exit(bars, entry_px, side, cfg, target_px=None, trigger_low=None):
    """Walk the forward bars and return the exit.

    bars: iterable of dicts with keys open/high/low/close, strictly AFTER the
    entry bar (i.e. the bars a position could actually be exited on).
    target_px: absolute target price; defaults to entry + target_r * risk.
    trigger_low: low of the TRIGGER/ENTRY candle. When supplied, rule 1 is armed
        before the first forward bar so the stop can trigger on bar 1.

    Stop-adjustment timing
    ----------------------
    A new stop level computed on bar `t` applies from bar `t+1`, never on bar
    `t` itself. We cannot know the intrabar order of high and low, so letting a
    freshly-raised stop trigger on the same bar that raised it would silently
    assume the favourable extreme came after the adjustment and would inflate
    every win.

    Returns a dict with exit_price, exit_reason, exit_bar, duration_bars,
    risk_points, net_points, first_target_bar, be_moved, profit_locked.
    """
    be_trigger = float(cfg.breakeven_trigger_points())
    res = {"exit_price": float("nan"), "exit_reason": "NO_BARS", "exit_bar": 0,
           "duration_bars": 0, "risk_points": float("nan"),
           "net_points": float("nan"), "first_target_bar": None,
           "be_moved": False, "profit_locked": False,
           "target_price": float("nan"), "mfe_points": 0.0, "mae_points": 0.0}
    if side != "long":
        raise ValueError("buy-only engine supports long premium only")

    stop, risk = None, None
    if trigger_low is not None and np.isfinite(float(trigger_low)):
        stop, risk = initial_stop(entry_px, float(trigger_low), side, cfg)
    target = (float(target_px) if target_px is not None and np.isfinite(target_px)
              else None)
    # Derive the target as soon as the risk is known. Leaving this until the
    # first forward bar meant that arming the stop from the trigger candle
    # (the normal path) skipped the `stop is None` branch below, so `target`
    # stayed None for every trade and the take-profit never armed at all.
    if target is None and risk is not None:
        target = entry_px + cfg.target_r * risk

    mfe = mae = 0.0
    prev_low = prev_high = None
    pending_stop = None
    i = 0
    cl = float("nan")

    for i, b in enumerate(bars, start=1):
        try:
            o = float(b["open"]); hi = float(b["high"])
            lo = float(b["low"]); cl = float(b["close"])
        except (TypeError, ValueError, KeyError):
            continue
        if not all(np.isfinite(x) for x in (o, hi, lo, cl)):
            continue

        # arm a stop computed on the previous bar (tighten only, never loosen)
        if pending_stop is not None:
            stop = max(stop, pending_stop)
            pending_stop = None

        if stop is None:
            stop, risk = initial_stop(entry_px, min(lo, o), side, cfg)
            if target is None:
                target = entry_px + cfg.target_r * risk

        fav = hi - entry_px
        adv = cl - entry_px
        mfe = max(mfe, fav)
        mae = min(mae, adv)

        # rule 4: trail behind the PREVIOUS candle's extreme. This one applies to
        # the CURRENT bar: the previous candle's low is known at this bar's open,
        # so using it here is causal, not a look-ahead. Tightens only, and only
        # once the stop has been armed at or above entry.
        if prev_low is not None and side == "long" and stop >= entry_px:
            stop = max(stop, prev_low - float(cfg.trail_buffer_points))

        # --- rules 2 and 3: effective NEXT bar ----------------------------
        # These depend on THIS bar's high, so applying them to this bar would
        # assume the favourable extreme arrived after the adjustment.
        if not res["be_moved"] and fav >= be_trigger:
            pending_stop = entry_px
            res["be_moved"] = True
        if not res["profit_locked"] and fav >= risk:
            lock = entry_px + cfg.profit_lock_fraction * fav
            pending_stop = lock if pending_stop is None else max(pending_stop, lock)
            res["profit_locked"] = True

        if res["first_target_bar"] is None and target is not None and hi >= target:
            res["first_target_bar"] = i

        hit_stop = lo <= stop
        hit_target = target is not None and hi >= target
        if hit_stop or hit_target:
            px = stop if hit_stop else target       # conservative: stop first
            res.update({"exit_price": float(px), "exit_reason": "STOP" if hit_stop else "TARGET",
                        "exit_bar": i, "duration_bars": i, "risk_points": risk,
                        "target_price": float(target) if target is not None else float("nan"),
                        "mfe_points": mfe, "mae_points": mae})
            res["net_points"] = res["exit_price"] - entry_px
            return res
        prev_low = lo
        prev_high = hi

    if not np.isfinite(cl):
        return res
    if stop is None:
        stop, risk = initial_stop(entry_px, min(float(entry_px), float(cl)), side, cfg)
    res.update({"exit_price": float(cl), "exit_reason": "TIME",
                "exit_bar": i, "duration_bars": i, "risk_points": risk,
                "target_price": float(target) if target is not None else float("nan"),
                "mfe_points": mfe, "mae_points": mae})
    res["net_points"] = res["exit_price"] - entry_px
    return res

    # time stop
    res.update({"exit_price": float(cl), "exit_reason": "TIME",
                "exit_bar": i, "duration_bars": i,
                "risk_points": risk_entry_stop,
                "target_price": float(target) if target is not None else float("nan"),
                "mfe_points": mfe, "mae_points": mae})
    res["net_points"] = res["exit_price"] - entry_px
    return res