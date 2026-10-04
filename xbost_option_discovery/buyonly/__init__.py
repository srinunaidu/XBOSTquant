"""Option Buy-Only backtesting and execution engine (Nifty / BankNifty).

Objective: maximise WIN RATE with MINIMAL trades (quality over quantity).

Modules
-------
config       BuyOnlySettings - every threshold, and the config fingerprint
underlying   ATM/ITM reference (futures first, put-call parity fallback)
features     causal price-action / volume / OI features
hypotheses   the four setups (VOLATILITY_COIL, OI_VELOCITY, LIQUIDITY_FLUSH,
             VWAP_SNAP_BACK)
regime       TRENDING / COMPRESSING / CHOPPY + the AdaptiveEngine brain
exits        structure stop -> breakeven -> 50% profit lock -> 1-candle trail
engine       event-driven backtester with next-bar-open fills and real costs
report       WR / PF / MaxDD / time-to-target, logic map, hypothesis ranking
"""
from .config import BuyOnlySettings
from .underlying import build_reference, build_underlying, audit_moneyness
from .features import add_session_features
from .hypotheses import run_all, availability, HYPOTHESIS_NAMES
from .regime import classify_regimes, regime_summary, AdaptiveEngine
from . import exits
from .engine import run_backtest
from .report import (summarize, by_hypothesis, significance, logic_map,
                     report_markdown, bootstrap_ci, signal_permutation_test,
                     sensitivity, max_drawdown)

__all__ = [
    "BuyOnlySettings", "build_reference", "build_underlying", "audit_moneyness",
    "add_session_features", "run_all", "availability", "HYPOTHESIS_NAMES",
    "classify_regimes", "regime_summary", "AdaptiveEngine", "exits",
    "run_backtest", "summarize", "by_hypothesis", "significance", "logic_map",
    "report_markdown", "bootstrap_ci", "signal_permutation_test", "sensitivity",
    "max_drawdown",
]