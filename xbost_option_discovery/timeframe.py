"""Time normalization (§6). Detect bar frequency; RAW or OHLCV resampling.
Resampling is causal: Open=first High=max Low=min Close=last Volume=sum within
each completed bin labelled by its left edge. No look-ahead."""
import numpy as np
import pandas as pd

FREQS = ("1m", "2m", "3m", "5m", "10m", "15m", "30m")

_IDENTITY_COLS = ("expiry", "strike", "option_type", "underlying")


def _norm_rule(rule):
    r = str(rule).strip().lower()
    if r.endswith("min"):
        return r
    if r.endswith("m"):
        return r[:-1] + "min"
    return r


def session_grid(timestamps, freq="1min"):
    """Union of observed minute stamps, built independently per day so the
    grid never bridges an overnight, weekend or holiday gap."""
    t = pd.to_datetime(pd.Series(timestamps)).dropna()
    if len(t) == 0:
        return pd.DatetimeIndex([])
    parts = []
    for _, g in t.groupby(t.dt.normalize()):
        lo, hi = g.min(), g.max()
        if pd.notna(lo) and pd.notna(hi) and hi >= lo:
            parts.append(pd.date_range(lo, hi, freq=freq))
    if not parts:
        return pd.DatetimeIndex([])
    return pd.DatetimeIndex(np.unique(np.concatenate([p.values for p in parts])))


def align_to_grid(norm, freq="1min"):
    """Reindex every contract onto the union session grid. OHLCV stays NaN
    where a contract did not trade (never forward-filled); only static
    per-contract identity metadata is propagated within the contract."""
    if norm is None or len(norm) == 0:
        return norm
    rule = _norm_rule(freq)
    df = norm.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df["symbol"] = df["symbol"].astype(str)
    df = df.dropna(subset=["timestamp"])
    dup = int(df.duplicated(subset=["symbol", "timestamp"]).sum())
    if dup:
        df = df.drop_duplicates(subset=["symbol", "timestamp"], keep="last")
    grid = session_grid(df["timestamp"], rule)
    if len(grid) == 0:
        return norm
    syms = pd.Index(sorted(df["symbol"].unique()), name="symbol")
    idx = pd.MultiIndex.from_product([syms, grid], names=["symbol", "timestamp"])
    out = df.set_index(["symbol", "timestamp"]).reindex(idx)
    for col in _IDENTITY_COLS:
        if col in out.columns:
            out[col] = out.groupby(level="symbol")[col].ffill().bfill()
    out = out.reset_index()
    out.attrs["ALIGNMENT"] = {"input_rows": int(len(norm)), "output_rows": int(len(out)),
                              "dropped_duplicates": dup, "grid_minutes": int(len(grid)),
                              "contracts": int(len(syms)), "rule": rule}
    return out.sort_values(["timestamp", "symbol"]).reset_index(drop=True)


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
