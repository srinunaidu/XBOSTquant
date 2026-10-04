"""Regime classification and the adaptive engine ("the brain").

Regimes
-------
TRENDING     Kaufman efficiency ratio is high: price travels in a direction and
             covers ground with little backtracking.
COMPRESSING  Direction is weak but range is NOT expanding: the coil is tightening
             and energy is coiling.
CHOPPY       Direction is weak AND range is expanding: whipsaw conditions where
             a stop-out is more likely than a directional follow-through.

CHOPPY is the shutdown state. It is defined by the conjunction of low efficiency
and EXPANDING range, so an ordinary quiet tape is classified COMPRESSING (which
is tradeable via the coil hypothesis) instead of being banned along with the
chop.

Why efficiency ratio and not an indicator
-----------------------------------------
ER = |close_t - close_{t-n}| / sum(|close_i - close_{i-1}|). It is pure path
geometry: 1.0 means a straight line, ~0 means the price went nowhere. No RSI, no
MACD, no moving-average crossover is involved.

The adaptive engine
-------------------
A small state machine with three shutdown paths, all fail-closed:

  * CHOPPY regime            -> no new positions this bar
  * 2 consecutive losses     -> halt until a cooldown elapses
  * cooldown active          -> flat, mandatory

The loss counter resets on any winning exit, so the engine resumes as soon as
the strategy proves itself again rather than staying halted for the session.
"""
import numpy as np
import pandas as pd

TRENDING = "TRENDING"
COMPRESSING = "COMPRESSING"
CHOPPY = "CHOPPY"

# which hypothesis is authorised in each regime (the logic map)
REGIME_TO_HYPOTHESIS = {
    COMPRESSING: "VOLATILITY_COIL",
    TRENDING: "LIQUIDITY_FLUSH",
    CHOPPY: None,
}


def classify_regimes(u, cfg):
    """Per-bar regime label. Purely causal (uses only bars <= t)."""
    df = u.copy()
    er = pd.to_numeric(df["eff_ratio"], errors="coerce")
    rp = pd.to_numeric(df["range_pctile"], errors="coerce")

    trending = er >= cfg.er_trend
    choppy = (~trending) & (rp >= cfg.range_expand_percentile)
    compressing = ~trending & ~choppy

    reg = pd.Series(COMPRESSING, index=df.index, dtype=object)
    reg[trending.fillna(False)] = TRENDING
    reg[choppy.fillna(False)] = CHOPPY
    # a bar with no usable statistics is not tradeable as COMPRESSING; mark it
    reg[er.isna() | rp.isna()] = "UNKNOWN"
    df["regime"] = reg
    df["hypothesis_for_regime"] = df["regime"].map(
        lambda r: REGIME_TO_HYPOTHESIS.get(r) if r in REGIME_TO_HYPOTHESIS else None)
    return df


def regime_summary(df):
    s = df["regime"].value_counts().to_dict()
    return {"TRENDING": int(s.get(TRENDING, 0)), "COMPRESSING": int(s.get(COMPRESSING, 0)),
            "CHOPPY": int(s.get(CHOPPY, 0)), "UNKNOWN": int(s.get("UNKNOWN", 0))}


class AdaptiveEngine:
    """Fail-closed trade authoriser.

    `allow(timestamp_regime, hypothesis)` decides whether a signal may open a
    position. `on_exit(pnl_points)` feeds the realised result back so the
    consecutive-loss circuit breaker can trip.

    The engine can also *veto a hypothesis that is not the one authorised for the
    current regime*: a signal from VOLATILITY_COIL during a TRENDING tape is
    rejected, which is what makes this an adaptive selector rather than a filter.
    """

    def __init__(self, cfg, restrict_to_regime_hypothesis=True):
        self.cfg = cfg
        self.restrict = bool(restrict_to_regime_hypothesis)
        self.consecutive_losses = 0
        self.max_consecutive_losses_seen = 0
        self.shutdown_count = 0
        self.shutdown_reasons = {}
        self.blocked_choppy = 0
        self.blocked_loss_streak = 0
        self.blocked_cooldown = 0
        self.blocked_regime_mismatch = 0
        self.loss_streak_shutdowns = 0

    # -- internal -------------------------------------------------------
    def _shut(self, reason):
        self.shutdown_count += 1
        self.shutdown_reasons[reason] = self.shutdown_reasons.get(reason, 0) + 1
        if reason == "LOSS_STREAK":
            self.loss_streak_shutdowns += 1

    # -- public ---------------------------------------------------------
    def allow(self, regime, hypothesis, in_cooldown=False):
        """Return (allowed: bool, reason: str)."""
        if in_cooldown:
            self.blocked_cooldown += 1
            return False, "COOLDOWN"
        if self.cfg.require_regime_permission and regime == CHOPPY:
            self.blocked_choppy += 1
            return False, "CHOPPY_REGIME"
        if self.consecutive_losses >= self.cfg.max_consecutive_losses:
            self.blocked_loss_streak += 1
            return False, "LOSS_STREAK"
        expected = REGIME_TO_HYPOTHESIS.get(regime)
        if self.restrict and expected is not None and hypothesis != expected:
            self.blocked_regime_mismatch += 1
            return False, "REGIME_HYPOTHESIS_MISMATCH"
        return True, "OK"

    def on_exit(self, pnl_points):
        """Feed a realised result (in points, net of cost) back into the breaker."""
        if pnl_points is None or not np.isfinite(pnl_points):
            return
        if pnl_points > 0:
            self.consecutive_losses = 0
        else:
            # a scratch (exactly breakeven) counts as a non-win for the breaker
            self.consecutive_losses += 1
            self.max_consecutive_losses_seen = max(
                self.max_consecutive_losses_seen, self.consecutive_losses)
            if self.consecutive_losses >= self.cfg.max_consecutive_losses:
                self._shut("LOSS_STREAK")

    def stats(self):
        return {"shutdowns": self.shutdown_count,
                "shutdown_reasons": dict(self.shutdown_reasons),
                "loss_streak_shutdowns": self.loss_streak_shutdowns,
                "max_consecutive_losses": self.max_consecutive_losses_seen,
                "blocked_choppy": self.blocked_choppy,
                "blocked_loss_streak": self.blocked_loss_streak,
                "blocked_cooldown": self.blocked_cooldown,
                "blocked_regime_mismatch": self.blocked_regime_mismatch}