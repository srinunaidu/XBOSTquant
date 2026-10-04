"""Causal price-action / volume / OI features for the buy-only engine.

Every feature here uses only bars at or before t. Nothing is centred, nothing is
back-filled, and every rolling statistic is grouped by session so a window can
never span the overnight gap.

Indicator policy: no RSI, no MACD, no moving-average crossover. A rolling mean
appears only as the centre of a dispersion statistic (VWAP sigma, range
percentile), never as a level price is compared against to fire a signal.
"""
import numpy as np
import pandas as pd


def _day(df):
    return pd.to_datetime(df["timestamp"]).dt.normalize()


def add_session_features(u, er_window=30):
    """VWAP, dispersion, range geometry, efficiency ratio, volume context."""
    df = u.sort_values("timestamp").copy()
    day = _day(df)
    out = df.copy()

    # ---- session VWAP (typical price x volume), reset each day -------------
    tp = (pd.to_numeric(df["high"], errors="coerce")
          + pd.to_numeric(df["low"], errors="coerce")
          + pd.to_numeric(df["close"], errors="coerce")) / 3.0
    vol = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0)
    num = (tp * vol)
    g = pd.DataFrame({"day": day, "num": num, "vol": vol}).groupby("day")
    cum_n = g["num"].cumsum()
    cum_v = g["vol"].cumsum()
    out["vwap"] = np.where(cum_v > 0, cum_n / cum_v.replace(0, np.nan), tp)
    out["vwap"] = pd.to_numeric(out["vwap"], errors="coerce")

    # ---- dispersion around VWAP: rolling std of (close - vwap) ------------
    dev = (pd.to_numeric(df["close"], errors="coerce") - out["vwap"]).abs()
    out["vwap_dev"] = dev
    out["vwap_sigma"] = (dev.groupby(day).transform(
        lambda s: s.rolling(60, min_periods=20).std()))
    out["vwap_z"] = np.where(out["vwap_sigma"] > 0, dev / out["vwap_sigma"], np.nan)

    # ---- range geometry ----------------------------------------------------
    hi = pd.to_numeric(df["high"], errors="coerce")
    lo = pd.to_numeric(df["low"], errors="coerce")
    cl = pd.to_numeric(df["close"], errors="coerce")
    prev_cl = cl.groupby(day).shift(1)
    tr = pd.concat([(hi - lo).abs(), (hi - prev_cl).abs(), (lo - prev_cl).abs()],
                   axis=1).max(axis=1)
    out["true_range"] = tr
    # 20-bar range as a fraction of price: how tight is the coil?
    rng = hi.groupby(day).transform(lambda s: s.rolling(20, min_periods=5).max()) \
        - lo.groupby(day).transform(lambda s: s.rolling(20, min_periods=5).min())
    out["range_pct"] = np.where(cl > 0, rng / cl * 100.0, np.nan)
    out["atr_pct"] = np.where(cl > 0, tr.groupby(day).transform(
        lambda s: s.rolling(20, min_periods=5).mean()) / cl * 100.0, np.nan)

    # ---- causal percentile of the CURRENT range inside its own history -----
    # rank of range_pct among the trailing window, inclusive of t. Strictly
    # causal: no future bar contributes to the reference distribution.
    out["range_pctile"] = out.groupby(day)["range_pct"].transform(
        lambda s: s.rolling(120, min_periods=30).apply(
            lambda w: float((w <= w[-1]).sum()) / max(1, np.isfinite(w).sum()) * 100.0,
            raw=True))

    # ---- volume context ----------------------------------------------------
    out["vol_med"] = vol.groupby(day).transform(
        lambda s: s.rolling(20, min_periods=5).median())
    out["vol_ratio"] = np.where(out["vol_med"] > 0, vol / out["vol_med"], np.nan)
    out["vol_pctile"] = vol.groupby(day).transform(
        lambda s: s.rolling(120, min_periods=20).apply(
            lambda w: float((w <= w[-1]).sum()) / max(1, len(w)) * 100.0, raw=True))

    # ---- Kaufman efficiency ratio: net move / total path -------------------
    net = (cl - cl.groupby(day).shift(er_window)).abs()
    path = (cl - cl.groupby(day).shift(1)).abs().groupby(day).transform(
        lambda s: s.rolling(er_window, min_periods=5).sum())
    out["eff_ratio"] = np.where(path > 0, net / path, np.nan)

    # ---- swing levels EXCLUDING the most recent bars -----------------------
    # A swing high is the highest high of the window that ENDED k bars ago, so the
    # level is known before the current bar and cannot be self-referential.
    out["swing_high"] = hi.groupby(day).transform(
        lambda s: s.shift(2).rolling(30, min_periods=10).max())
    out["swing_low"] = lo.groupby(day).transform(
        lambda s: s.shift(2).rolling(30, min_periods=10).min())

    return out.reset_index(drop=True)


def add_oi_features(u, quotes):
    """Chain-level open interest aggregates, per contract per timestamp.

    Returns (underlying_with_oi_cols, oi_frame). When the dataset carries no OI
    the frame is empty and every OI hypothesis must report NOT_APPLICABLE rather
    than silently degrading to something that looks like an OI test.
    """
    if quotes is None or len(quotes) == 0 or "oi" not in quotes.columns:
        return u, pd.DataFrame()
    q = quotes.dropna(subset=["oi"]).copy()
    if q.empty:
        return u, pd.DataFrame()
    agg = q.groupby(["timestamp", "strike", "option_type"], as_index=False)["oi"].sum()
    return u, agg