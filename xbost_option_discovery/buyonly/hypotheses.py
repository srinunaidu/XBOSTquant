"""The four buy-only discovery hypotheses.

Contract for every hypothesis
-----------------------------
Each detector returns a DataFrame of SIGNAL ROWS with a fixed schema:

    timestamp | hypothesis | direction | trigger_high | trigger_low | detail

`direction` is the side to BUY: `CE` (bullish) or `PE` (bearish). There is no
`short` - this engine buys options only.

Every detector is causal: it may use bars up to and including the trigger bar,
and the entry is filled on the FOLLOWING bar (see engine.py), so a signal can
never be acted on using information from its own fill bar.

Hypothesis notes
----------------
VOLATILITY_COIL  range compression -> volume spike -> breakout
OI_VELOCITY      price breaks an OI wall -> OI collapses (short covering)
LIQUIDITY_FLUSH  false breakout of a swing level -> reversal candle on volume
VWAP_SNAP_BACK   price leaves the VWAP band -> reversal candle -> mean reversion

OI_VELOCITY requires an open-interest field. When the dataset has none the
detector returns an empty frame AND a NOT_APPLICABLE reason, so the report can
never present a volume proxy as if it were an OI test.
"""
import numpy as np
import pandas as pd

from .features import _day

SIGNAL_COLS = ["timestamp", "hypothesis", "direction", "trigger_high",
               "trigger_low", "trigger_close", "detail"]

HYPOTHESIS_NAMES = ("VOLATILITY_COIL", "OI_VELOCITY", "LIQUIDITY_FLUSH", "VWAP_SNAP_BACK")


def _empty():
    return pd.DataFrame({c: [] for c in SIGNAL_COLS})


def _reversal_candle(o, h, l, c, bullish):
    """A reversal candle: closes back inside the level it pierced, with a body.

    Deliberately geometric, not an indicator: for a bullish reversal the bar
    made a lower low versus the previous bar and then closed back above the open
    (and above the midpoint of its own range), and vice versa.
    """
    prev_c = c.shift(1)
    if bullish:
        return (l < l.shift(1)) & (c > o) & (c > (h + l) / 2.0) & (c > prev_c)
    return (h > h.shift(1)) & (c < o) & (c < (h + l) / 2.0) & (c < prev_c)


def volatility_coil(u, cfg):
    """Range compression -> volume spike -> breakout of the coil.

    Compression is measured as the CURRENT 20-bar range sitting in the bottom
    `coil_range_percentile`% of its own trailing distribution, plus the coil
    being tighter than the immediately preceding stretch (contraction, not just
    a quiet level). The trigger bar must then spike volume and close outside the
    coil's high (buy CE) or low (buy PE).
    """
    df = u
    o = pd.to_numeric(df["open"], errors="coerce")
    h = pd.to_numeric(df["high"], errors="coerce")
    l = pd.to_numeric(df["low"], errors="coerce")
    c = pd.to_numeric(df["close"], errors="coerce")
    day = _day(df)
    w = int(cfg.coil_window)

    coil_hi = h.groupby(day).transform(lambda s: s.rolling(w, min_periods=5).max())
    coil_lo = l.groupby(day).transform(lambda s: s.rolling(w, min_periods=5).min())
    # the coil EXCLUDES the trigger bar itself (shift 1), otherwise the trigger
    # bar defines the range it is supposed to break
    coil_hi_prev = coil_hi.groupby(day).shift(1)
    coil_lo_prev = coil_lo.groupby(day).shift(1)

    tight = pd.to_numeric(df["range_pctile"], errors="coerce")
    contracting = coil_hi_prev - coil_lo_prev < (
        coil_hi.groupby(day).shift(4) - coil_lo.groupby(day).shift(4))
    vol_spike = pd.to_numeric(df["vol_ratio"], errors="coerce") >= cfg.coil_vol_mult

    armed = (tight <= cfg.coil_range_percentile) & contracting
    up = armed & vol_spike & (c > coil_hi_prev)
    dn = armed & vol_spike & (c < coil_lo_prev)

    sig = pd.DataFrame({
        "timestamp": df["timestamp"],
        "hypothesis": "VOLATILITY_COIL",
        "direction": np.where(up, "CE", np.where(dn, "PE", "")),
        "trigger_high": h, "trigger_low": l, "trigger_close": c,
        "detail": ("range_pctile<=%.0f & vol_ratio>=%.1f & breakout"
                   % (cfg.coil_range_percentile, cfg.coil_vol_mult)),
    })
    sig = sig[sig["direction"] != ""].copy()
    if len(sig):
        sig["direction"] = sig["direction"].where(sig["direction"] != "", np.nan)
    return sig.reset_index(drop=True)


def oi_velocity(u, quotes, cfg):
    """Price breaks an OI wall, then OI collapses = short covering.

    NOT_APPLICABLE when the dataset has no OI field. That is reported rather
    than substituted, because a volume stand-in would not test short covering.
    """
    if quotes is None or len(quotes) == 0 or "oi" not in quotes.columns:
        return _empty()
    q = quotes.dropna(subset=["oi"]).copy()
    if q.empty:
        return _empty()

    q["timestamp"] = pd.to_datetime(q["timestamp"])
    lb = int(cfg.oi_lookback)
    walls = {}
    for otype, side in (("CE", "CE"), ("PE", "PE")):
        sub = q[q["option_type"].astype(str).str.upper() == otype]
        if sub.empty:
            continue
        wide = sub.pivot_table(index="timestamp", columns="strike", values="oi", aggfunc="first")
        if wide.shape[1] == 0:
            continue
        # OI resistance = the strike carrying the most open interest in the
        # lookback (a call wall above / put wall below)
        prior = wide.shift(1)
        wall_oi = prior.rolling(lb, min_periods=5).max()
        wall = wall_oi.idxmax(axis=1)
        walls[side] = wall
        walls[side + "_oi"] = wall_oi.max(axis=1)
        walls[side + "_wide"] = wide

    if "CE" not in walls or "PE" not in walls:
        return _empty()

    px = u.set_index("timestamp")
    rows = []
    for otype in ("CE", "PE"):
        wall = walls[otype]
        wall_oi = walls[otype + "_oi"]
        wide = walls[otype + "_wide"]
        prev = wall.shift(1)
        broken = (wall.notna() & prev.notna() & (wall != prev))
        # price traded through the previous wall level
        through = pd.Series(False, index=wall.index)
        hi = px["high"].reindex(wall.index) if "high" in px else None
        lo = px["low"].reindex(wall.index) if "low" in px else None
        cl = px["close"].reindex(wall.index) if "close" in px else None
        if hi is None or lo is None or cl is None:
            continue
        if otype == "CE":
            through = (hi > prev) | (cl > prev)      # broke above a call wall
            direction = "CE"
        else:
            through = (lo < prev) | (cl < prev)      # broke below a put wall
            direction = "PE"
        # rapid OI decrease after the break (short covering)
        drop = (wall_oi.shift(cfg.oi_drop_bars) - wall_oi) / wall_oi.shift(cfg.oi_drop_bars) * 100.0
        fire = broken & through & (drop >= cfg.oi_drop_pct)
        idx = fire[fire.fillna(False)].index
        for t in idx:
            i = wall.index.get_loc(t)
            rows.append({"timestamp": t, "hypothesis": "OI_VELOCITY",
                         "direction": direction,
                         "trigger_high": float(hi.iloc[i]), "trigger_low": float(lo.iloc[i]),
                         "trigger_close": float(cl.iloc[i]),
                         "detail": "wall_strike=%s oi_drop=%.1f%% over %db" % (
                             wall.iloc[i], float(drop.iloc[i]), cfg.oi_drop_bars)})
    if not rows:
        return _empty()
    return pd.DataFrame(rows)[SIGNAL_COLS].sort_values("timestamp").reset_index(drop=True)


def liquidity_flush(u, cfg):
    """A false breakout of a prior swing level reverses, on volume.

    The swing level excludes the two most recent bars, so it is known before the
    bar that pierces it. A bar that pierces but then closes back inside within
    `flush_reject_bars` bars is the flush; it must carry a reversal candle and
    above-average volume. Piercing DOWN a swing low and rejecting => buy CE.
    """
    df = u
    o = pd.to_numeric(df["open"], errors="coerce")
    h = pd.to_numeric(df["high"], errors="coerce")
    l = pd.to_numeric(df["low"], errors="coerce")
    c = pd.to_numeric(df["close"], errors="coerce")
    sh = pd.to_numeric(df["swing_high"], errors="coerce")
    sl = pd.to_numeric(df["swing_low"], errors="coerce")
    day = _day(df)
    vr = pd.to_numeric(df["vol_ratio"], errors="coerce")
    n = int(cfg.flush_reject_bars)

    pierced_down = (l < sl)
    pierced_up = (h > sh)
    # reject back inside within the next n bars (inclusive of the pierce bar)
    back_in_above = c > sl.shift(1).fillna(np.inf)
    fwd_min_above = l.shift(-1).rolling(n, min_periods=1).min().shift(-(n - 1))
    fwd_max_below = h.shift(-1).rolling(n, min_periods=1).max().shift(-(n - 1))

    bull_rej = pierced_down & (back_in_above | (fwd_min_above > sl)) & \
        _reversal_candle(o, h, l, c, True) & (vr >= cfg.flush_vol_mult)
    bear_rej = pierced_up & ((c < sh.shift(1).fillna(-np.inf)) | (fwd_max_below < sh)) & \
        _reversal_candle(o, h, l, c, False) & (vr >= cfg.flush_vol_mult)

    sig = pd.DataFrame({
        "timestamp": df["timestamp"],
        "hypothesis": "LIQUIDITY_FLUSH",
        "direction": np.where(bull_rej, "CE", np.where(bear_rej, "PE", "")),
        "trigger_high": h, "trigger_low": l, "trigger_close": c,
        "detail": "false break of swing level, reject<=%db, vol_ratio>=%.1f" % (n, cfg.flush_vol_mult),
    })
    sig = sig[sig["direction"] != ""].copy()
    if len(sig):
        sig["direction"] = sig["direction"].where(sig["direction"] != "", np.nan)
    return sig.reset_index(drop=True)


def vwap_snap_back(u, cfg):
    """Price stretches away from VWAP, prints a reversal candle, reverts to VWAP.

    z = |close - vwap| / rolling sigma. Only bars beyond `vwap_z` sigmas qualify.
    A bullish snap (price stretched BELOW the band) buys CE; a bearish snap
    (stretched ABOVE) buys PE. The mean-reversion target is the VWAP itself,
    which is also what makes this hypothesis measurable on "time to target".
    """
    df = u
    o = pd.to_numeric(df["open"], errors="coerce")
    h = pd.to_numeric(df["high"], errors="coerce")
    l = pd.to_numeric(df["low"], errors="coerce")
    c = pd.to_numeric(df["close"], errors="coerce")
    vwap = pd.to_numeric(df["vwap"], errors="coerce")
    z = pd.to_numeric(df["vwap_z"], errors="coerce")

    below = (z >= cfg.vwap_z) & (c < vwap)
    above = (z >= cfg.vwap_z) & (c > vwap)
    bull = below & _reversal_candle(o, h, l, c, True)
    bear = above & _reversal_candle(o, h, l, c, False)

    sig = pd.DataFrame({
        "timestamp": df["timestamp"],
        "hypothesis": "VWAP_SNAP_BACK",
        "direction": np.where(bull, "CE", np.where(bear, "PE", "")),
        "trigger_high": h, "trigger_low": l, "trigger_close": c,
        "detail": "|z|>=%.1f sigma from session VWAP + reversal candle; target=VWAP" % cfg.vwap_z,
    })
    sig = sig[sig["direction"] != ""].copy()
    if len(sig):
        sig["direction"] = sig["direction"].where(sig["direction"] != "", np.nan)
    return sig.reset_index(drop=True)


DETECTORS = {
    "VOLATILITY_COIL": lambda u, q, cfg: volatility_coil(u, cfg),
    "OI_VELOCITY": lambda u, q, cfg: oi_velocity(u, q, cfg),
    "LIQUIDITY_FLUSH": lambda u, q, cfg: liquidity_flush(u, cfg),
    "VWAP_SNAP_BACK": lambda u, q, cfg: vwap_snap_back(u, cfg),
}


def availability(quotes):
    """Which hypotheses this dataset can honestly evaluate."""
    has_oi = bool(quotes is not None and len(quotes) and "oi" in quotes.columns
                  and quotes["oi"].notna().any())
    av = {}
    for name in HYPOTHESIS_NAMES:
        if name == "OI_VELOCITY":
            av[name] = ("AVAILABLE" if has_oi else
                        "NOT_AVAILABLE (no open_interest field in dataset)")
        else:
            av[name] = "AVAILABLE"
    return av


def run_all(u, quotes, cfg):
    """Run every detector. Returns (combined_signals, availability_map)."""
    av = availability(quotes)
    frames = []
    for name, fn in DETECTORS.items():
        if not av[name].startswith("AVAILABLE"):
            continue
        try:
            s = fn(u, quotes, cfg)
            if s is not None and len(s):
                frames.append(s)
        except Exception as e:  # a broken detector must not kill the run
            av[name] = f"ERROR ({type(e).__name__}: {e})"
    out = pd.concat(frames, ignore_index=True) if frames else _empty()
    if len(out):
        out = out.sort_values(["timestamp", "hypothesis"]).reset_index(drop=True)
    return out, av