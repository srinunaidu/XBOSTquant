"""Execution cost model for Indian index options (P1).

Why this exists
---------------
Every backtest in this repo charged ZERO cost (`backtest.py` wrote `cost = 0.0` and
`fingerprint(... |cost=ZERO| ...)`). For Indian options that is not a rounding
detail, it is the whole result. On a Rs.200 BankNifty premium with a 15-lot,
Rs.20/order brokerage alone is Rs.40 round trip = Rs.2.67 per unit = **1.33% of
premium** - larger than the entire 1% take-profit the discovery pipeline was
testing. A costless run cannot be paper-traded and must never pass the paper gate.

Costs are expressed as a PERCENTAGE OF ENTRY PREMIUM so they compose directly with
the ledger's `ret` (which is also a percentage). Two consequences are deliberate:
  * brokerage is per ORDER per LOT, so cheap premiums have a brutally higher
    percentage cost - which is exactly the real trade-off;
  * the model is exact for the buy leg and linearised for the sell leg (the exit
    premium is not known before the trade). The error is second order and the
    approximation is always reported in `CostBreakdown.approx`.
"""
from dataclasses import dataclass, asdict, field
import math


@dataclass
class OptionCostModel:
    """Round-trip cost of one option leg, in percent of entry premium."""
    brokerage_per_order: float = 20.0     # Rs. per order (discount broker)
    orders_per_leg: int = 2               # entry + exit
    stt_sell_pct: float = 0.1             # STT on the SELL leg, % of premium
    exchange_pct: float = 0.0495          # NSE options txn charge, % of premium, per side
    sebi_pct: float = 0.0001              # SEBI turnover fee, % of premium, per side
    stamp_buy_pct: float = 0.003          # stamp duty, buy side only
    gst_pct: float = 18.0                 # GST on (brokerage + exchange + sebi)
    slippage_bps: float = 5.0             # per side, bps of premium (fallback)
    lot_size: int = 15
    use_spread: bool = True               # prefer observed bid/ask over slippage_bps

    def round_trip_pct(self, premium, lot_size=None, spread_pct=None):
        """Total round-trip cost as % of entry premium.

        spread_pct: observed full bid/ask spread as % of mid, when available. The
        round trip pays roughly half the spread on entry and half on exit, i.e. one
        full spread in total.
        """
        p = float(premium)
        lot = int(lot_size or self.lot_size)
        if not math.isfinite(p) or p <= 0 or lot <= 0:
            return float("nan")
        notional = p * lot
        brokerage = self.brokerage_per_order * self.orders_per_leg / notional * 100.0
        exchange = self.exchange_pct * 2
        sebi = self.sebi_pct * 2
        stt = self.stt_sell_pct
        stamp = self.stamp_buy_pct
        gst = self.gst_pct / 100.0 * (brokerage + exchange + sebi)
        if self.use_spread and spread_pct is not None and math.isfinite(spread_pct):
            slip = float(spread_pct)
        else:
            slip = self.slippage_bps / 100.0 * 2
        return brokerage + exchange + sebi + stt + stamp + gst + slip

    def breakdown(self, premium, lot_size=None, spread_pct=None):
        p = float(premium); lot = int(lot_size or self.lot_size)
        if not math.isfinite(p) or p <= 0 or lot <= 0:
            return {"total_pct": float("nan")}
        notional = p * lot
        brokerage = self.brokerage_per_order * self.orders_per_leg / notional * 100.0
        exchange = self.exchange_pct * 2
        sebi = self.sebi_pct * 2
        gst = self.gst_pct / 100.0 * (brokerage + exchange + sebi)
        if self.use_spread and spread_pct is not None and math.isfinite(spread_pct):
            slip = float(spread_pct); slip_src = "observed_spread"
        else:
            slip = self.slippage_bps / 100.0 * 2; slip_src = "slippage_bps"
        total = (brokerage + exchange + sebi + self.stt_sell_pct + self.stamp_buy_pct
                 + gst + slip)
        return {"brokerage_pct": brokerage, "exchange_pct": exchange, "sebi_pct": sebi,
                "stt_pct": self.stt_sell_pct, "stamp_pct": self.stamp_buy_pct,
                "gst_pct": gst, "slippage_pct": slip, "slippage_source": slip_src,
                "total_pct": total, "lot_size": lot, "premium": p,
                "cost_rupees_per_lot": total / 100.0 * p * lot,
                "approx": "sell-leg statutory charges linearised at entry premium"}

    def signature(self):
        d = asdict(self)
        return "|".join(f"{k}={d[k]}" for k in sorted(d))

    def to_dict(self):
        return asdict(self)


ZERO_COST = OptionCostModel(brokerage_per_order=0.0, stt_sell_pct=0.0, exchange_pct=0.0,
                           sebi_pct=0.0, stamp_buy_pct=0.0, gst_pct=0.0,
                           slippage_bps=0.0, use_spread=False)

PRESETS = {
    # lot sizes are exchange lot sizes and MUST be set by the operator before a run
    "NIFTY_OPT": OptionCostModel(lot_size=75),
    "BANKNIFTY_OPT": OptionCostModel(lot_size=15),
    "BANKNIFTY_OPT_WIDE": OptionCostModel(lot_size=15, slippage_bps=15.0),
    "ZERO": ZERO_COST,
}


def build(cost_mode="REALISTIC", preset=None, lot_size=None, slippage_bps=None,
          brokerage_per_order=None, **kw):
    """Construct a cost model. `cost_mode='ZERO'` returns the zero model and is
    flagged so the paper gate can refuse it.

    In ZERO mode every parameter override is IGNORED: previously the default
    `--slippage-bps 5` was still written onto the zero model, so a run explicitly
    labelled "ZERO cost" silently charged slippage and its fingerprint stopped
    saying `cost=ZERO`.
    """
    if str(cost_mode).upper() == "ZERO":
        return OptionCostModel(**asdict(ZERO_COST))
    base = PRESETS.get(preset or "", OptionCostModel())
    m = OptionCostModel(**asdict(base))
    if lot_size is not None:
        m.lot_size = int(lot_size)
    if slippage_bps is not None:
        m.slippage_bps = float(slippage_bps)
    if brokerage_per_order is not None:
        m.brokerage_per_order = float(brokerage_per_order)
    for k, v in kw.items():
        if hasattr(m, k):
            setattr(m, k, v)
    return m


def cost_mode_is_real(cost_mode, model):
    import math as _math
    try:
        _probe = float(model.round_trip_pct(100.0, model.lot_size))
    except Exception:
        return False
    return str(cost_mode).upper() != "ZERO" and _math.isfinite(_probe) and _probe != 0.0


_ZERO_FIELDS = ("brokerage_per_order", "stt_sell_pct", "exchange_pct", "sebi_pct",
                "stamp_buy_pct", "gst_pct", "slippage_bps")


def is_zero(model):
    return all(float(getattr(model, f, 0.0)) == 0.0 for f in _ZERO_FIELDS)


def grid_economics(sl_pct, tp_pct, cost_pct):
    """Can a long-premium SL/TP grid survive its own transaction cost?

    A stop-out realises -(sl + cost); a target hit realises +(tp - cost). If
    `tp <= cost` the grid CANNOT be profitable at any win rate. Otherwise the
    break-even win rate is loss/(loss+win) - a lower bound, because time exits
    realise something in between.

    This is the single most useful number in the whole report: on BankNifty at a
    ~Rs.750 premium the round trip is ~0.87%, so a 0.5%/1.0% grid needs a 91% win
    rate and is dead on arrival no matter how good the signal is.
    """
    c = float(cost_pct)
    win = float(tp_pct) - c
    loss = float(sl_pct) + c
    if not (loss > 0):
        return {"viable": False, "reason": "degenerate grid", "net_win_pct": win,
                "net_loss_pct": -loss, "breakeven_wr": float("nan")}
    if win <= 0:
        return {"viable": False, "net_win_pct": win, "net_loss_pct": -loss,
                "breakeven_wr": float("nan"),
                "reason": (f"take-profit ({tp_pct}%) is not larger than the round-trip "
                           f"cost ({c:.3f}%): the target nets {win:.3f}%")}
    be = loss / (loss + win)
    return {"viable": be < 0.75, "net_win_pct": win, "net_loss_pct": -loss,
            "breakeven_wr": be, "reward_risk_net": win / loss,
            "reason": (f"needs a {be:.1%} win rate before any edge is counted"
                       + ("" if be < 0.75 else " - implausibly high for this grid"))}


def signature(model):
    """Canonical cost label for ledger fingerprints: 'ZERO' for a zero model,
    otherwise the full parameter signature."""
    return "ZERO" if is_zero(model) else model.signature()
