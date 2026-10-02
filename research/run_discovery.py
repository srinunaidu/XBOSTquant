"""DEPRECATED — superseded by xbost_option_discovery/.

This module was the first-generation options discovery engine. It is retained only
as a shim so stale invocations fail loudly instead of silently producing the old
report. See xbost_option_discovery/run.py for the current engine.

>>> python3 -m xbost_option_discovery.run --path "Data test/banknifty_options.csv"
"""
import sys

_MESSAGE = (
    "research/ is DEPRECATED and no longer runs. The current option-native discovery\n"
    "engine is xbost_option_discovery/ (strict 6-contract ingestion, canonical metrics,\n"
    "OHLC exit propagation, chronological OOS).\n\n"
    "Run instead:\n"
    "    python3 -m xbost_option_discovery.run --path \"Data test/banknifty_options.csv\""
)


def _fail():
    sys.stderr.write(_MESSAGE + "\n")
    raise SystemExit(3)


def load_dataset(*a, **k):
    _fail()


def main(*a, **k):
    _fail()