"""Track A (OHLCV-only) vs Track B (all available data) for discovery.

The research universe is NEVER restricted by track: both tracks search the
same full contract universe. Tracks differ only in which FIELDS may drive a
hypothesis:

- Track A: single-contract OHLCV fields only (open/high/low/close/volume and
  the identity keys needed for grouping). No cross-contract columns, no OI,
  no bid/ask, no underlying-derived columns.
- Track B: every valid field actually present (relationships across
  contracts, OI-derived events when OI exists, ...). Nothing is fabricated:
  families requiring absent fields report UNSUPPORTED_METHOD.

Tracks share canonical data, splits, embargo, validation, the global
multiple-testing ledger and checkpoint infrastructure, but keep independent
frontiers, method memory and hypothesis namespaces. Candidate IDs encode the
track (``A_H000001`` / ``B_H000001``).
"""
import pandas as pd
import numpy as np

TRACKS = ("A", "B")

# Input fields Track A may read. Identity keys are structural (grouping),
# not signal: they carry no market information.
TRACK_A_INPUT_FIELDS = frozenset({"open", "high", "low", "close", "volume"})
TRACK_A_KEY_COLUMNS = frozenset({"timestamp", "symbol", "symbol_id", "expiry",
                                 "strike", "option_type", "underlying", "day"})
TRACK_A_BLOCKED_FIELDS = frozenset({"bid", "ask", "iv", "delta", "gamma",
                                    "theta", "vega", "oi", "spread",
                                    "underlying", "spot", "index"})

# Feature columns that are single-contract OHLCV derivations. A depth-1 spec
# is Track A iff every column it references is in this set (or is a selector
# / scope / sequence-pattern column, which are OHLCV- or identity-derived by
# construction). Cross-contract columns (type_*, *_retdiff, breadth_*,
# *_leads_*, divergence/convergence/catchup, e_atm_move, state_id, oi_*)
# are Track B.
TRACK_A_FEATURE_COLUMNS = frozenset({
    "e_large_ret", "e_vol_shock", "e_compression", "e_expansion",
    "ev_largeRet_volShock", "ev_compress_expand", "ev_ret_vol_expand",
    "seq_compress_expand", "seq2", "seq3",
})

# Families natively belonging to Track A (single-contract OHLCV). Every other
# family (relationships, breadth, lead-lag, divergence/convergence/catchup,
# chain state, OI, scope/side-expiry variants are assigned per below) is
# Track B. COMBINATION/EXITVAR inherit the stricter of parent/leg.
TRACK_A_FAMILIES = frozenset({
    "RAW_OPTION_PRICE", "OPTION_VOLUME", "EVENT", "SEQUENCE",
})

# Scope families are identity-derived (no market fields) and legal in both
# tracks. Selector families are trailing-OHLCV-derived: legal in both.
SCOPE_FAMILIES = frozenset({
    "SCOPE_SIDE", "SCOPE_EXPIRY", "SCOPE_STRIKE", "SCOPE_CONTRACT",
})
SELECTOR_FAMILIES = frozenset({
    "SEL_VOL_RANK", "SEL_MOM_RANK",
})
INHERIT_FAMILIES = frozenset({"COMBINATION", "EXITVAR"})


def spec_track(family, columns):
    """Decide the track for one depth-1 spec. Returns 'A' or 'B'."""
    if family in TRACK_A_FAMILIES and all(
            c in TRACK_A_FEATURE_COLUMNS for c in columns):
        return "A"
    if family in SCOPE_FAMILIES or family in SELECTOR_FAMILIES:
        return "BOTH"
    return "B"


def child_track(parent_track, leg_columns):
    """Combo child track: the stricter of parent track and leg columns."""
    if parent_track == "B":
        return "B"
    if all(c in TRACK_A_FEATURE_COLUMNS for c in leg_columns):
        return "A"
    return "B"


def candidate_id(track, hid):
    return f"{track}_{hid}"


def track_allows_column(track, col):
    """Guard used at mask resolution: Track A may only touch single-contract
    OHLCV columns, selector columns and identity scope columns."""
    if track != "A":
        return True
    if col in TRACK_A_FEATURE_COLUMNS:
        return True
    if col in ("sel_vol_rank", "sel_mom_rank", "sel_vol_trail",
               "sel_mom_trail"):
        return True
    if col in ("symbol", "symbol_id", "strike", "expiry", "option_type",
               "timestamp", "day"):
        return True
    if col in ("seq2", "seq3"):
        return True
    return False


# ---------------------------------------------------------------------------
# Track B: OI-derived events (only when the field actually exists)
# ---------------------------------------------------------------------------

def oi_coverage(feat):
    """Fraction of rows with a usable OI print. Below threshold the OI family
    reports UNSUPPORTED_METHOD instead of running on noise."""
    if "oi" not in feat.columns:
        return 0.0
    return float(feat["oi"].notna().mean())


def add_oi_events(feat, min_coverage=0.5):
    """OI shock events mirroring the volume-shock logic. Returns
    (frame, status) where status is AVAILABLE / INSUFFICIENT_DATA /
    UNSUPPORTED_METHOD. Past-only: trailing percentiles with shift."""
    cov = oi_coverage(feat)
    if "oi" not in feat.columns:
        return feat, "UNSUPPORTED_METHOD (no oi field in dataset)"
    if not (cov >= min_coverage):
        return feat, (f"INSUFFICIENT_DATA (oi coverage {cov:.2f} "
                       f"< {min_coverage})")
    g = feat.sort_values(["symbol", "timestamp"]).groupby("symbol")["oi"]
    # Past-only trailing percentile (same pattern as volume_percentile:
    # shift(1) excludes the current bar from its own reference window).
    def _pct(s):
        return s.shift(1).rolling(120, min_periods=20).apply(
            lambda w: (w <= w.iloc[-1]).mean() * 100 if len(w) else np.nan,
            raw=False)
    pct = g.transform(_pct)
    feat = feat.copy()
    feat["oi_percentile"] = pct.values if hasattr(pct, "values") else pct
    feat["e_oi_shock"] = (feat["oi_percentile"] >= 95).astype(float).fillna(0)
    return feat, "AVAILABLE"


# ---------------------------------------------------------------------------
# Dynamic contract selectors (past-only trailing ranks)
# ---------------------------------------------------------------------------

SELECTOR_WARMUP = {"sel_vol_rank": 20, "sel_mom_rank": 30}


def add_selector_columns(feat):
    """Rank contracts per bar by trailing (past-only) volume and momentum.

    sel_vol_rank / sel_mom_rank: 1 = largest trailing value at that bar.
    Rows without enough history stay NaN and are never selected (no signal
    is preferable to a warmup-contaminated one). Used by both tracks: the
    inputs are OHLCV-derived and the audit below pins them to history.
    """
    feat = feat.copy()
    g = feat.sort_values(["symbol", "timestamp"])
    vol_trail = g.groupby("symbol")["volume"].transform(
        lambda s: s.shift(1).rolling(60, min_periods=20).sum())
    mom_trail = g.groupby("symbol")["close"].transform(
        lambda s: s / s.shift(30) - 1.0)
    # Index-aligned assignment (never positional .values: the sorted frame
    # order need not match feat order, and scrambling here would silently
    # move trailing statistics across contracts).
    feat["sel_vol_trail"] = vol_trail
    feat["sel_mom_trail"] = mom_trail
    feat["sel_vol_rank"] = feat.groupby("timestamp")["sel_vol_trail"].rank(
        ascending=False, method="min")
    feat["sel_mom_rank"] = feat.groupby("timestamp")["sel_mom_trail"].rank(
        ascending=False, method="min")
    return feat


def audit_selectors(feat, sample_timestamps=12, seed=7):
    """Independently recompute selector ranks from raw OHLCV (explicitly
    shifted, different code path) and require exact agreement on sampled
    timestamps. Returns dict with status PASS / LOOKAHEAD_DETECTED /
    INSUFFICIENT_DATA. Any future leakage in the selectors fails closed."""
    need = {"sel_vol_rank", "sel_mom_rank", "volume", "close", "symbol",
            "timestamp"}
    if not need.issubset(set(feat.columns)):
        return {"status": "INSUFFICIENT_DATA", "checked": 0,
                "mismatches": 0, "note": "selector columns absent"}
    rng = np.random.default_rng(seed)
    stamps = sorted(feat["timestamp"].dropna().unique().tolist())
    if not stamps:
        return {"status": "INSUFFICIENT_DATA", "checked": 0,
                "mismatches": 0, "note": "no timestamps"}
    pick = sorted(rng.choice(stamps, size=min(sample_timestamps, len(stamps)),
                             replace=False).tolist())
    mism = 0
    checked = 0
    raw = feat[["symbol", "timestamp", "volume", "close"]].copy()
    for ts in pick:
        # Signal-time convention (matches the engine): the decision at bar
        # ts may use bars <= ts, never anything after ts. Recompute trailing
        # values per contract, rank across contracts, compare with feat.
        # Only contracts printing AT ts are ranked; symbols with history
        # but no bar at ts are not in the rank universe.
        present = set(
            feat.loc[feat["timestamp"] == ts, "symbol"].astype(str))
        if not present:
            continue
        per_sym = {}
        for sym, sub in raw[(raw["timestamp"] <= ts) &
                            (raw["symbol"].isin(present))].groupby("symbol"):
            sub = sub.sort_values("timestamp")
            prior = sub.iloc[:-1]  # strictly before ts
            ev = (prior["volume"].iloc[-60:].sum()
                  if len(prior) >= 20 else np.nan)
            em = (sub["close"].iloc[-1] / sub["close"].iloc[-31] - 1.0
                  if len(sub) >= 31 else np.nan)
            per_sym[sym] = (ev, em)
        if not per_sym:
            continue
        exp_vol = pd.Series({s: v[0] for s, v in per_sym.items()}).rank(
            ascending=False, method="min")
        exp_mom = pd.Series({s: v[1] for s, v in per_sym.items()}).rank(
            ascending=False, method="min")
        for sym in per_sym:
            got = feat[(feat["timestamp"] == ts) & (feat["symbol"] == sym)]
            if not len(got):
                continue
            gv = got["sel_vol_rank"].iloc[0]
            checked += 1
            ev = exp_vol.get(sym, np.nan)
            if not ((pd.isna(ev) and pd.isna(gv)) or ev == gv):
                mism += 1
            gm = got["sel_mom_rank"].iloc[0]
            checked += 1
            em = exp_mom.get(sym, np.nan)
            if not ((pd.isna(em) and pd.isna(gm)) or em == gm):
                mism += 1
    if checked == 0:
        return {"status": "INSUFFICIENT_DATA", "checked": 0,
                "mismatches": 0, "note": "no checkable bars"}
    if mism:
        return {"status": "LOOKAHEAD_DETECTED", "checked": checked,
                "mismatches": mism,
                "note": f"{mism}/{checked} selector ranks disagree with "
                        f"history-only recomputation"}
    return {"status": "PASS", "checked": checked, "mismatches": 0,
            "note": f"{checked} selector ranks match history-only "
                    f"recomputation"}


# ---------------------------------------------------------------------------
# Capability map additions
# ---------------------------------------------------------------------------

def track_capability(norm, feat):
    """Capability map for the two tracks, built from the actual dataset."""
    has_oi = bool("oi" in norm.columns and norm["oi"].notna().any())
    has_bidask = bool(any(c in norm.columns for c in ("bid", "ask")) and
                      norm[[c for c in ("bid", "ask")
                            if c in norm.columns]].notna().any().any())
    n_exp = int(norm["expiry"].astype(str).nunique()) if "expiry" in norm.columns else 0
    n_str = int(pd.to_numeric(norm["strike"], errors="coerce").dropna().nunique()) \
        if "strike" in norm.columns else 0
    otypes = sorted(norm["option_type"].astype(str).unique().tolist()) \
        if "option_type" in norm.columns else []
    return {
        "HAS_OHLCV": True,
        "HAS_OI": has_oi,
        "HAS_BID_ASK": has_bidask,
        "MULTIPLE_EXPIRIES": n_exp >= 2,
        "MULTIPLE_STRIKES": n_str >= 2,
        "CE_AND_PE": len([o for o in otypes if "C" in o]) >= 1 and
                     len([o for o in otypes if "P" in o]) >= 1,
        "n_expiries": n_exp,
        "n_strikes": n_str,
        "option_types": otypes,
        "TRACK_A": "OHLCV single-contract families",
        "TRACK_B": ("cross-contract relationships + OI events"
                    if has_oi else "cross-contract relationships"),
    }
