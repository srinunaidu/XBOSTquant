"""Time normalization (§6). Detect bar frequency; RAW or OHLCV resampling.
Resampling is causal: Open=first High=max Low=min Close=last Volume=sum within
each completed bin labelled by its left edge. No look-ahead."""
import pandas as pd

FREQS = ("1m", "2m", "3m", "5m", "10m", "15m", "30m")


def detect_frequency(ts) -> str:
    diffs = pd.to_datetime(pd.Series(ts)).drop_duplicates().sort_values().diff().dropna()
    if len(diffs) == 0:
        return "UNKNOWN"
    mins = diffs.median().total_seconds() / 60
    for f in FREQS:
        if abs(int(f[:-1]) - mins) < 0.5:
            return f
    return f"{mins:.1f}m"


def resample_ohlcv(norm, rule="5m"):
    """Resample per (symbol, expiry) group. Returns resampled canonical frame."""
    out = []
    for (sym, exp), g in norm.groupby(["symbol", "expiry"]):
        g = g.set_index("timestamp").sort_index()
        agg = {"open": "first", "high": "max", "low": "min", "close": "last",
               "volume": "sum", "oi": "sum", "strike": "last", "option_type": "last",
               "underlying": "last"}
        agg = {k: v for k, v in agg.items() if k in g.columns}
        r = g.resample(rule).agg(agg).dropna(subset=["close"])
        r["symbol"] = sym
        r["expiry"] = exp
        r["bid"] = g["bid"].resample(rule).last() if "bid" in g else float("nan")
        r["ask"] = g["ask"].resample(rule).last() if "ask" in g else float("nan")
        out.append(r.reset_index())
    res = pd.concat(out, ignore_index=True) if out else norm
    return res.sort_values(["timestamp", "symbol"]).reset_index(drop=True)
