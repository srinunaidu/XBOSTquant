"""Event-driven backtester for the Option Buy-Only strategy.

Pipeline for one run
--------------------
  signals (hypotheses)  ->  regime gate  ->  adaptive engine  ->  contract
  selection (ATM/ITM)   ->  next-bar open entry  ->  exit architecture
  ->  costs  ->  ledger  ->  metrics

Causality
---------
* a signal is generated on bar `t` and filled at the OPEN of bar `t+1`;
* the exit may only use bars strictly after the entry bar;
* the regime that authorises a trade is the regime on the SIGNAL bar, never a
  regime computed later;
* selection uses the ATM reference of the signal bar, not the entry bar, so the
  strike choice cannot benefit from knowing the fill.

Costs
-----
Round-trip cost comes from `xbost_option_discovery.costs.OptionCostModel` and is
converted to price points per unit so it can be subtracted from the gross points
P&L directly. A backtest that scores a premium-only edge without brokerage, STT,
exchange, GST, stamp duty and slippage cannot be traded, so costs are never zero.
"""
import numpy as np
import pandas as pd

from ..costs import OptionCostModel
from . import exits as EX
from .hypotheses import SIGNAL_COLS
from .regime import CHOPPY, COMPRESSING, TRENDING, AdaptiveEngine, REGIME_TO_HYPOTHESIS

LEDGER_COLS = [
    "trade_id", "timestamp", "entry_time", "exit_time", "hypothesis", "direction",
    "regime", "symbol", "strike", "expiry", "moneyness",
    "entry_price", "exit_price", "exit_reason", "duration_bars",
    "gross_points", "cost_points", "net_points", "net_pct",
    "risk_points", "mfe_points", "mae_points",
    "lots", "rupee_pnl", "be_moved", "profit_locked",
    "first_target_bar", "time_to_target_bars", "blocked_reason",
]


def _empty_ledger():
    return pd.DataFrame({c: [] for c in LEDGER_COLS})


class ContractBook:
    """Fast per-contract lookup of 1m OHLC paths."""

    def __init__(self, quotes):
        self.by_symbol = {}
        q = quotes.copy()
        q["timestamp"] = pd.to_datetime(q["timestamp"])
        for sym, g in q.groupby(q["symbol"].astype(str), sort=False):
            g = g.sort_values("timestamp")
            rec = {
                "ts": pd.DatetimeIndex(g["timestamp"]),
                "open": pd.to_numeric(g["open"], errors="coerce").to_numpy(float),
                "high": pd.to_numeric(g["high"], errors="coerce").to_numpy(float),
                "low": pd.to_numeric(g["low"], errors="coerce").to_numpy(float),
                "close": pd.to_numeric(g["close"], errors="coerce").to_numpy(float),
                "volume": (pd.to_numeric(g["volume"], errors="coerce").to_numpy(float)
                           if "volume" in g else np.full(len(g), np.nan)),
                "strike": (pd.to_numeric(g["strike"], errors="coerce").iloc[0]
                           if "strike" in g else np.nan),
                "expiry": (str(g["expiry"].iloc[0]) if "expiry" in g else "UNKNOWN"),
                "option_type": (str(g["option_type"].iloc[0]) if "option_type" in g
                                else "UNKNOWN"),
                "pos": {t: i for i, t in enumerate(g["timestamp"])},
            }
            self.by_symbol[sym] = rec

    def locate(self, symbol, ts):
        rec = self.by_symbol.get(symbol)
        if rec is None:
            return None, None
        i = rec["pos"].get(pd.Timestamp(ts))
        if i is None:
            # next available bar at or after ts (ragged chain)
            j = rec["ts"].searchsorted(pd.Timestamp(ts), side="left")
            if j >= len(rec["ts"]):
                return None, None
            i = int(j)
        return rec, i

    def forward(self, rec, i, n):
        sl = slice(i + 1, i + 1 + n)
        return [{"open": rec["open"][k], "high": rec["high"][k],
                 "low": rec["low"][k], "close": rec["close"][k]}
                for k in range(sl.start, min(sl.stop, rec["close"].__len__()))
                if np.isfinite(rec["open"][k]) and np.isfinite(rec["close"][k])]


def select_contract(book, underlying_row, direction, cfg, strike_step=None):
    """Pick the ATM (or a near-ITM) contract for the requested side.

    Buy-only universe: for a bullish signal only strikes at or below the ATM are
    tradable (ATM or ITM calls); for a bearish signal only strikes at or above it.
    Out-of-the-money contracts are never selected. ITM depth is measured in
    strike steps derived from the ladder itself, never a hardcoded interval.
    """
    atm = underlying_row.get("atm")
    if atm is None or not np.isfinite(atm):
        return None, "NO_ATM_REFERENCE"
    otype = "CE" if str(direction).upper() == "CE" else "PE"
    step = float(strike_step) if strike_step and np.isfinite(strike_step) and strike_step > 0 else 1.0

    best = None
    for sym, rec in book.by_symbol.items():
        if rec["option_type"].upper() != otype:
            continue
        k = rec["strike"]
        if not np.isfinite(k):
            continue
        if otype == "CE":
            if k > atm:            # OTM call -> forbidden
                continue
            depth = atm - k       # >= 0 : ITM depth in points
        else:
            if k < atm:            # OTM put -> forbidden
                continue
            depth = k - atm
        dist = abs(k - atm)
        itm_steps = int(round(depth / step)) if depth > 1e-9 else 0
        if itm_steps > cfg.max_itm_steps:
            continue              # deeper than allowed -> not selectable
        # Rank first by how close the contract is to the DESIRED ITM depth, then
        # by nearness to ATM. Preferring depth matters because brokerage is fixed
        # per lot, so a deeper ITM contract amortises the same round-trip cost
        # over a much larger premium.
        cand = (abs(itm_steps - int(cfg.target_itm_steps)), dist, str(sym))
        if best is None or cand < best[0]:
            best = (cand, sym, rec, itm_steps)
    if best is None:
        return None, "NO_ATM_OR_ITM_CONTRACT"
    _, sym, rec, itm_steps = best
    moneyness = "ATM" if itm_steps == 0 else "ITM"
    return {"symbol": sym, "strike": rec["strike"], "expiry": rec["expiry"],
            "option_type": otype, "moneyness": moneyness,
            "itm_steps": itm_steps}, "OK"


def cost_points(cost_model, entry_px, cfg):
    """Round-trip cost in price POINTS per unit for this entry premium."""
    pct = cost_model.round_trip_pct(entry_px, cfg.lot_size)
    if not np.isfinite(pct):
        return float("nan")
    return entry_px * pct / 100.0


def run_backtest(signals, underlying, quotes, cfg, restrict_to_regime=True,
                 cost_model=None):
    """Run the full buy-only backtest. Returns (ledger, audit_dict)."""
    ledger = _empty_ledger()
    audit = {"signals_in": int(len(signals)), "trades": 0,
             "blocked": {}, "skipped_no_contract": 0,
             "skipped_no_entry_bar": 0, "skipped_bad_price": 0,
             "cooldown_bars": 0}
    if signals is None or len(signals) == 0 or quotes is None or len(quotes) == 0:
        return ledger, audit

    cm = cost_model or OptionCostModel(
        brokerage_per_order=cfg.brokerage_per_order,
        lot_size=cfg.lot_size, use_spread=False)
    book = ContractBook(quotes)
    _strikes = np.sort(pd.Series(quotes["strike"]).dropna().astype(float).unique())
    if len(_strikes) > 1:
        _d = np.diff(_strikes); _d = _d[_d > 0]
        strike_step = float(np.median(_d)) if len(_d) else None
    else:
        strike_step = None

    u = underlying.sort_values("timestamp").reset_index(drop=True)
    u_ts = pd.DatetimeIndex(pd.to_datetime(u["timestamp"]))
    regime_by_ts = dict(zip(u_ts, u["regime"]))
    row_by_ts = {t: u.iloc[i] for i, t in enumerate(u_ts)}

    eng = AdaptiveEngine(cfg, restrict_to_regime_hypothesis=restrict_to_regime)
    sig = signals.sort_values("timestamp").reset_index(drop=True)

    # one position at a time: no pyramiding, so the win rate stays interpretable
    busy_until = None
    cooldown_until_ts = None
    rows = []
    trade_id = 0
    block_counts = {}

    for _, s in sig.iterrows():
        ts = pd.Timestamp(s["timestamp"])
        regime = regime_by_ts.get(ts, "UNKNOWN")
        hypo = s["hypothesis"]

        if busy_until is not None and ts <= busy_until:
            block_counts["ALREADY_IN_POSITION"] = block_counts.get("ALREADY_IN_POSITION", 0) + 1
            continue

        in_cooldown = cooldown_until_ts is not None and ts < cooldown_until_ts
        allowed, reason = eng.allow(regime, hypo, in_cooldown=in_cooldown)
        if not allowed:
            block_counts[reason] = block_counts.get(reason, 0) + 1
            if reason == "LOSS_STREAK":
                # the breaker fires once; force a flat window before it can fire
                # again, measured in bars on the underlying timeline
                cooldown_until_ts = _ts_after(u_ts, ts, cfg.shutdown_cooldown_bars)
                eng.consecutive_losses = 0
            continue

        crow = row_by_ts.get(ts)
        if crow is None:
            block_counts["NO_UNDERLYING_BAR"] = block_counts.get("NO_UNDERLYING_BAR", 0) + 1
            continue

        sel, sel_reason = select_contract(book, crow, s["direction"], cfg,
                                       strike_step=strike_step)
        if sel is None:
            audit["skipped_no_contract"] += 1
            block_counts[sel_reason] = block_counts.get(sel_reason, 0) + 1
            continue

        # entry on the NEXT bar of that contract (causal fill)
        rec, i = book.locate(sel["symbol"], ts)
        if rec is None or i + 1 >= len(rec["close"]):
            audit["skipped_no_entry_bar"] += 1
            continue
        j = i + 1
        entry_t = rec["ts"][j]
        entry_px = float(rec["open"][j])
        trig_low = float(rec["low"][i]) if np.isfinite(rec["low"][i]) else entry_px
        if not np.isfinite(entry_px) or entry_px <= 0:
            audit["skipped_bad_price"] += 1
            continue

        bars = book.forward(rec, j, cfg.max_hold_bars)
        if not bars:
            audit["skipped_no_entry_bar"] += 1
            continue

        # VWAP snap-back aims at the mean; use the VWAP target when it is nearer
        target_px = None
        if hypo == "VWAP_SNAP_BACK":
            v = crow.get("vwap")
            if v is not None and np.isfinite(v):
                target_px = float(v) if str(s["direction"]).upper() == "CE" else float(v)

        res = EX.run_exit(bars, entry_px, "long", cfg,
                          target_px=target_px, trigger_low=trig_low)
        exit_px = res["exit_price"]
        if not np.isfinite(exit_px) or exit_px <= 0:
            audit["skipped_bad_price"] += 1
            continue

        cp = cost_points(cm, entry_px, cfg)
        if not np.isfinite(cp):
            audit["skipped_bad_price"] += 1
            continue
        gross = exit_px - entry_px
        net = gross - cp
        net_pct = (net / entry_px * 100.0) if entry_px > 0 else float("nan")

        exit_idx = min(j + res["duration_bars"], len(rec["ts"]) - 1)
        exit_t = rec["ts"][exit_idx]
        busy_until = exit_t

        trade_id += 1
        rows.append({
            "trade_id": trade_id, "timestamp": ts, "entry_time": entry_t,
            "exit_time": exit_t, "hypothesis": hypo, "direction": s["direction"],
            "regime": regime, "symbol": sel["symbol"], "strike": sel["strike"],
            "expiry": sel["expiry"], "moneyness": sel["moneyness"],
            "entry_price": entry_px, "exit_price": exit_px,
            "exit_reason": res["exit_reason"], "duration_bars": res["duration_bars"],
            "gross_points": gross, "cost_points": cp, "net_points": net,
            "net_pct": net_pct, "risk_points": res["risk_points"],
            "mfe_points": res["mfe_points"], "mae_points": res["mae_points"],
            "lots": cfg.max_lots,
            "rupee_pnl": net * cfg.lot_size * cfg.max_lots,
            "be_moved": res["be_moved"], "profit_locked": res["profit_locked"],
            "first_target_bar": res["first_target_bar"],
            "time_to_target_bars": res["first_target_bar"], "blocked_reason": "",
        })
        eng.on_exit(net)

    ledger = pd.DataFrame(rows) if rows else _empty_ledger()
    audit["trades"] = len(ledger)
    audit["blocked"] = block_counts
    audit["engine"] = eng.stats()
    return ledger, audit


def _ts_after(ts_index, ts, n):
    """Timestamp `n` bars after `ts` on the underlying timeline (cooldown end)."""
    try:
        j = int(ts_index.searchsorted(ts, side="left")) + int(n)
        if 0 <= j < len(ts_index):
            return ts_index[j]
    except Exception:
        pass
    return None