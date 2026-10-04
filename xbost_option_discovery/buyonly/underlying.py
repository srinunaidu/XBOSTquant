"""Underlying reference and ATM/ITM moneyness.

Why this layer exists
---------------------
Buying only ATM and ITM contracts requires knowing where the index is trading
relative to the strike ladder. The options file alone contains no spot, so two
independent estimators are used and the source is recorded per day:

1. `futures`  - the index futures 1m series, when the run supplies one. This is
   the authoritative reference.
2. `put_call_parity` - the strike where |CE - PE| is smallest. Valid ONLY while
   the true ATM lies inside the available strike ladder, because a truncated
   chain pins the estimate to its highest/lowest strike.

Truncation is the dangerous case and is detected, not silently absorbed: when
the estimator returns an edge strike it is flagged `ATM_AT_CHAIN_EDGE`, because
the true ATM is then outside the chain and "ITM" would be decided against a
reference that is wrong by an unknown number of strike steps. `audit_moneyness`
reports the coverage so a run can never quietly trade on a bad reference.
"""
import numpy as np
import pandas as pd


def _strike_step(strikes):
    s = np.sort(pd.Series(strikes).dropna().astype(float).unique())
    if len(s) < 2:
        return float("nan")
    d = np.diff(s)
    d = d[d > 0]
    return float(np.median(d)) if len(d) else float("nan")


def put_call_parity_atm(quotes):
    """Per-timestamp ATM strike from min |CE - PE|.

    quotes: long frame with timestamp/strike/option_type/close.
    Returns a Series indexed by timestamp with the ATM strike (may be NaN).
    """
    ce = quotes[quotes["option_type"].astype(str).str.upper() == "CE"]
    pe = quotes[quotes["option_type"].astype(str).str.upper() == "PE"]
    if ce.empty or pe.empty:
        return pd.Series(dtype="float64")
    a = ce.pivot_table(index="timestamp", columns="strike", values="close", aggfunc="first")
    b = pe.pivot_table(index="timestamp", columns="strike", values="close", aggfunc="first")
    shared = a.columns.intersection(b.columns)
    if len(shared) == 0:
        return pd.Series(dtype="float64")
    diff = (a[shared] - b[shared]).abs().dropna(how="all")
    if diff.empty:
        return pd.Series(dtype="float64")
    return diff.idxmin(axis=1).astype("float64")


def build_reference(quotes, futures=None):
    """Per-timestamp ATM reference with an explicit provenance column.

    Returns a DataFrame indexed by timestamp with columns
    `atm` and `atm_source` in {futures, put_call_parity, UNKNOWN}.
    """
    if quotes is None or len(quotes) == 0:
        return pd.DataFrame(columns=["atm", "atm_source"])

    pc = put_call_parity_atm(quotes)
    idx = pd.DatetimeIndex(sorted(pd.to_datetime(quotes["timestamp"]).unique()))
    atm = pd.Series(np.nan, index=idx, dtype="float64")
    src = pd.Series("UNKNOWN", index=idx, dtype=object)

    if futures is not None and len(futures):
        f = futures.copy()
        f["timestamp"] = pd.to_datetime(f["timestamp"])
        f = f.dropna(subset=["timestamp"]).drop_duplicates("timestamp", keep="last")
        f = f.set_index("timestamp").sort_index()
        # round the index level to the nearest listed strike
        step = _strike_step(quotes["strike"])
        lvl = pd.to_numeric(f["close"], errors="coerce")
        if np.isfinite(step) and step > 0:
            cand = pd.Series(
                (lvl / step).round() * step, index=f.index, dtype="float64")
            common = cand.index.intersection(atm.index)
            atm.loc[common] = cand.loc[common].to_numpy()
            src.loc[common] = "futures"

    # fill gaps from put-call parity
    need = atm.isna() & pc.notna()
    if need.any():
        common = pc.index.intersection(atm.index)
        keep = common[atm.loc[common].isna()]
        if len(keep):
            atm.loc[keep] = pc.loc[keep].to_numpy()
            src.loc[keep] = "put_call_parity"
    return pd.DataFrame({"atm": atm, "atm_source": src})


def audit_moneyness(ref, quotes):
    """Report how far the ATM reference sits from the available strike ladder.

    `atm_outside_ladder` is NOT an error: it means the index is trading beyond
    the listed strikes, so there is no true ATM contract and every listed strike
    is ITM. That is a legitimate (if deep-ITM) state and is reported so a reader
    can see the ladder was pinned, rather than being silently treated as ATM.
    """
    out = {"timestamps": int(len(ref)), "futures_rows": int((ref["atm_source"] == "futures").sum()),
           "parity_rows": int((ref["atm_source"] == "put_call_parity").sum()),
           "unknown_rows": int((ref["atm_source"] == "UNKNOWN").sum())}
    strikes = np.sort(pd.Series(quotes["strike"]).dropna().astype(float).unique())
    if len(strikes) >= 2 and len(ref):
        lo, hi = float(strikes[0]), float(strikes[-1])
        atm = ref["atm"]
        out["strike_min"], out["strike_max"] = lo, hi
        below = int((atm < lo).fillna(False).sum())
        above = int((atm > hi).fillna(False).sum())
        inside = int((atm.between(lo, hi)).fillna(False).sum())
        out["atm_below_ladder"] = below
        out["atm_above_ladder"] = above
        out["atm_inside_ladder"] = inside
        out["outside_ladder_pct"] = round(100.0 * (below + above) / max(1, out["timestamps"]), 2)
        out["status"] = "OK" if inside else "ATM_OUTSIDE_LADDER"
    else:
        out["status"] = "INSUFFICIENT_STRIKES"
    return out


def nearest_strike(ref_level, strikes):
    """Nearest listed strike to each reference level (vectorised)."""
    s = np.sort(pd.Series(strikes).dropna().astype(float).unique())
    if len(s) == 0:
        return pd.Series(np.nan, index=ref_level.index, dtype="float64")
    lv = pd.to_numeric(ref_level, errors="coerce")
    pos = np.searchsorted(s, lv.to_numpy(dtype="float64")).clip(1, len(s) - 1)
    lo = s[pos - 1]
    hi = s[pos]
    pick = np.where((lv.to_numpy(dtype="float64") - lo) <= (hi - lv.to_numpy(dtype="float64")), lo, hi)
    return pd.Series(np.where(np.isfinite(lv.to_numpy(dtype="float64")), pick, np.nan),
                     index=ref_level.index, dtype="float64")


def build_underlying(quotes, futures=None):
    """1m OHLC series for the underlying, used to drive signal generation.

    Source priority per day:
      * `futures`          - real index futures OHLC when available
      * `straddle_proxy`   - (CE_atm + PE_atm) / 2 at each bar. A synthetic
        index proxy: it moves with the index, is available on days the futures
        file does not cover, and carries a genuine OHLC path.

    The `underlying_source` column records which was used for every bar, so no
    conclusion is ever drawn from a proxy without it being visible.
    """
    if quotes is None or len(quotes) == 0:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close",
                                     "volume", "underlying_source"])
    q = quotes.copy()
    q["timestamp"] = pd.to_datetime(q["timestamp"])
    ref = build_reference(q, futures)

    if futures is not None and len(futures):
        f = futures.copy()
        f["timestamp"] = pd.to_datetime(f["timestamp"])
        keep = ["timestamp", "open", "high", "low", "close", "volume"]
        for c in keep:
            if c not in f.columns:
                f[c] = np.nan
        u = f[keep].dropna(subset=["timestamp"]).copy()
        u["underlying_source"] = "futures"
    else:
        u = pd.DataFrame(columns=["timestamp", "open", "high", "low",
                                  "close", "volume", "underlying_source"])

    # straddle proxy on every timestamp (used where futures is absent)
    piv = q.pivot_table(index="timestamp", columns="option_type",
                        values=["open", "high", "low", "close"], aggfunc="first")
    prox = pd.DataFrame(index=piv.index)
    ot = sorted({str(c).upper() for c in q["option_type"].unique()})
    for field in ("open", "high", "low", "close"):
        cols = [(field, t) for t in ot if (field, t) in piv.columns]
        if not cols:
            prox[field] = np.nan
        elif len(cols) == 1:
            prox[field] = piv[cols[0]]
        else:
            # mean of the two legs' mid-prices
            prox[field] = piv[cols].mean(axis=1)
    vol = q.pivot_table(index="timestamp", values="volume", aggfunc="sum")["volume"]
    prox["volume"] = vol.reindex(prox.index)
    # name the index BEFORE adding the column, otherwise reset_index() collides
    # with an existing "timestamp" column when no futures file is supplied
    prox.index.name = "timestamp"
    prox["timestamp"] = prox.index.to_numpy()
    prox["underlying_source"] = "straddle_proxy"

    if len(u):
        u = u.drop_duplicates("timestamp", keep="first").set_index("timestamp")
        px = prox.set_index("timestamp")[["open", "high", "low", "close", "volume"]]
        have_fut = u["close"].notna()
        merged = u[["open", "high", "low", "close", "volume"]].reindex(px.index).combine_first(px)
        merged.index.name = "timestamp"
        out = merged.reset_index()
        # provenance is decided per timestamp by which source actually supplied
        # the bar - a futures row must not inherit the label of a proxy row.
        out["underlying_source"] = np.where(
            have_fut.reindex(px.index).fillna(False).to_numpy(), "futures", "straddle_proxy")
    else:
        out = prox.reset_index(drop=True)
    out["day"] = pd.to_datetime(out["timestamp"]).dt.normalize()
    r = ref.reindex(pd.DatetimeIndex(pd.to_datetime(out["timestamp"])))
    out["atm"] = r["atm"].to_numpy()
    out["atm_source"] = r["atm_source"].fillna("UNKNOWN").to_numpy()
    return out.sort_values("timestamp").reset_index(drop=True)