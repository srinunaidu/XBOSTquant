"""Dynamic ingestion (§1-§4). No hardcoded strikes, types, symbols, expiries, or counts.

Schema detection is alias-driven and configurable: the engine inspects the input
columns and maps them onto the canonical representation. Both long-form and
wide-form option data normalize into the same canonical frame:

    timestamp | expiry | strike | option_type | symbol | open high low close volume
    (+ optional: oi, bid, ask, underlying when present)
"""
import pandas as pd
import numpy as np

# Configurable schema aliases. Defaults cover common conventions; callers may
# override via configure_schema(). These are *field roles*, never contract values.
SCHEMA_ALIASES = {
    "timestamp": ["timestamp", "ts", "ist", "date", "datetime", "time", "bar_time"],
    "expiry": ["expiry", "exp", "expiration", "expiry_date", "maturity"],
    "strike": ["strike", "strike_px", "strike_price", "k"],
    "option_type": ["option_type", "otype", "cp", "call_put", "type", "kind", "side"],
    "symbol": ["symbol", "contract", "contract_symbol", "instrument", "ticker"],
    "open": ["open", "o", "open_price"],
    "high": ["high", "h", "high_price"],
    "low": ["low", "l", "low_price"],
    "close": ["close", "c", "close_price", "last", "ltp", "settle"],
    "volume": ["volume", "vol", "v", "qty", "quantity", "traded_qty"],
    "oi": ["oi", "open_interest", "openinterest"],
    "bid": ["bid", "bid_price", "best_bid"],
    "ask": ["ask", "ask_price", "best_ask"],
    "underlying": ["underlying", "under", "spot", "index", "name"],
}

# Canonical option-type normalization (values, not structure): map common tokens
# onto themselves in upper case; unknown tokens pass through unchanged.
def _norm_otype(v):
    s = str(v).strip().upper()
    alias = {"C": "C", "CALL": "C", "P": "P", "PUT": "P",
             "CE": "CE", "PE": "PE"}
    return alias.get(s, s)


def configure_schema(overrides: dict):
    for role, names in overrides.items():
        SCHEMA_ALIASES[role] = list(names)


def _resolve(columns, role):
    cols = {c.lower(): c for c in columns}
    for cand in SCHEMA_ALIASES.get(role, []):
        if cand.lower() in cols:
            return cols[cand.lower()]
    return None


def detect_layout(df):
    """Return 'long' if a strike-like + price-like column set exists, else try 'wide'."""
    cols = list(df.columns)
    if _resolve(cols, "strike") is not None and _resolve(cols, "close") is not None:
        return "long"
    if _resolve(cols, "timestamp") is not None and _infer_wide_contracts(df):
        return "wide"
    raise ValueError(f"Cannot detect option-data layout from columns: {cols[:20]}")


def _field_suffix(col):
    """Split 'CONTRACT_anything_<field>' from the right; return (contract, role) or (None,None)."""
    if "_" not in col:
        return None, None
    head, _, tail = col.rpartition("_")
    if not head:
        return None, None
    for role in ("open", "high", "low", "close", "volume", "oi", "bid", "ask"):
        if tail.lower() in [a.lower() for a in SCHEMA_ALIASES[role]]:
            return head, role
    return None, None


def _infer_wide_contracts(df):
    contracts = {}
    for c in df.columns:
        contract, role = _field_suffix(str(c))
        if contract:
            contracts.setdefault(contract, {})[role] = c
    # keep contracts that carry at least a close-like field
    return {k: v for k, v in contracts.items() if "close" in v}


def _split_contract_token(token):
    """Best-effort strike/type split of a wide contract token using discovered
    option-type tokens is impossible without metadata, so keep the raw token as
    symbol and leave strike/option_type to be refined by detect_chain() when the
    token embeds them. Returns (strike_or_None, otype_or_None, symbol)."""
    return None, None, str(token)


def load_long(df, schema_over=None):
    cols = list(df.columns)
    m = {r: (_resolve(cols, r) if not (schema_over or {}).get(r) else (schema_over or {})[r])
         for r in SCHEMA_ALIASES}
    if m["timestamp"] is None or m["close"] is None:
        raise ValueError("Long-form data requires at least timestamp + close columns")
    out = pd.DataFrame()
    out["timestamp"] = pd.to_datetime(df[m["timestamp"]], errors="coerce")
    out["expiry"] = df[m["expiry"]].astype(str) if m["expiry"] else "UNKNOWN"
    if m["strike"] is not None:
        out["strike"] = pd.to_numeric(df[m["strike"]], errors="coerce")
    else:
        out["strike"] = np.nan
    out["option_type"] = df[m["option_type"]].map(_norm_otype) if m["option_type"] else "UNKNOWN"
    out["symbol"] = df[m["symbol"]].astype(str) if m["symbol"] else (
        out["strike"].astype(str) + "_" + out["option_type"].astype(str))
    for role in ("open", "high", "low", "close", "volume", "oi", "bid", "ask"):
        out[role] = pd.to_numeric(df[m[role]], errors="coerce") if m[role] else np.nan
    out["underlying"] = df[m["underlying"]].astype(str) if m["underlying"] else "UNKNOWN"
    out = out.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    return out


def load_wide(df, schema_over=None):
    cols = list(df.columns)
    ts_col = _resolve(cols, "timestamp")
    exp_col = _resolve(cols, "expiry")
    if ts_col is None:
        raise ValueError("Wide-form data requires a timestamp column")
    contracts = _infer_wide_contracts(df)
    if not contracts:
        raise ValueError("No <contract>_<field> columns detected for wide-form data")
    ts = pd.to_datetime(df[ts_col], errors="coerce")
    recs = []
    for token, fmap in contracts.items():
        strike, otype, symbol = _split_contract_token(token)
        n = len(df)
        rec = pd.DataFrame({
            "timestamp": ts,
            "expiry": df[exp_col].astype(str) if exp_col else "UNKNOWN",
            "strike": pd.to_numeric(pd.Series([strike] * n), errors="coerce"),
            "option_type": pd.Series([otype if otype else "UNKNOWN"] * n).map(_norm_otype),
            "symbol": pd.Series([symbol] * n).astype(str),
            "underlying": "UNKNOWN",
        })
        for role in ("open", "high", "low", "close", "volume", "oi", "bid", "ask"):
            rec[role] = pd.to_numeric(df[fmap[role]], errors="coerce") if role in fmap else np.nan
        recs.append(rec)
    out = pd.concat(recs, ignore_index=True).dropna(subset=["timestamp"])
    return out.sort_values(["timestamp", "symbol"]).reset_index(drop=True)


def load_dataset(path, schema_over=None):
    df = pd.read_csv(path)
    layout = detect_layout(df)
    norm = load_long(df, schema_over) if layout == "long" else load_wide(df, schema_over)
    return norm, layout


def detect_chain(norm):
    """Build chain_metadata purely from observed data. No expected values."""
    ts = pd.to_datetime(norm["timestamp"])
    contracts = sorted(norm["symbol"].astype(str).unique().tolist())
    strikes = sorted(pd.to_numeric(norm["strike"], errors="coerce").dropna().unique().tolist())
    otypes = sorted(norm["option_type"].astype(str).unique().tolist())
    expiries = sorted(norm["expiry"].astype(str).unique().tolist())
    per_exp = {e: sorted(norm.loc[norm["expiry"].astype(str) == e, "symbol"].astype(str).unique().tolist())
               for e in expiries}
    per_ts = norm.groupby("timestamp")["symbol"].apply(lambda s: set(s.astype(str).tolist()))
    full = set(contracts)
    complete = int((per_ts.apply(lambda s: s == full)).sum())
    missing_obs = norm[norm["close"].isna()].shape[0]
    dup_obs = int(norm.duplicated(subset=["timestamp", "symbol"]).sum())
    # focus: most-liquid strikes per expiry (configurable N at call site)
    return {
        "underlying": sorted(norm["underlying"].astype(str).unique().tolist()),
        "expiries": expiries,
        "n_expiries": len(expiries),
        "contracts_per_expiry": {e: len(v) for e, v in per_exp.items()},
        "strikes": [str(s) for s in strikes],
        "n_strikes": len(strikes),
        "option_types": otypes,
        "n_option_types": len(otypes),
        "contracts": contracts,
        "n_contracts": len(contracts),
        "timestamp_range": (str(ts.min()), str(ts.max())),
        "n_timestamps": int(ts.nunique()),
        "n_days": int(ts.dt.date.nunique()),
        "synchronized_snapshots": int(len(per_ts)),
        "complete_snapshots": complete,
        "partial_snapshots": int(len(per_ts) - complete),
        "completeness": round(complete / len(per_ts), 4) if len(per_ts) else 0.0,
        "missing_data": int(missing_obs),
        "duplicate_observations": dup_obs,
        "has_bidask": bool(norm[["bid", "ask"]].notna().any().any()),
        "has_oi": bool(norm["oi"].notna().any()),
    }


def select_focus(norm, meta, n_strikes=3, expiry=None):
    """Most-liquid N strikes (option-type agnostic) for the synchronized chain."""
    sub = norm if expiry is None else norm[norm["expiry"].astype(str) == str(expiry)]
    vol = sub.groupby("strike")["volume"].sum().sort_values(ascending=False)
    strikes = vol.head(n_strikes).index.tolist()
    chain = sorted(sub[sub["strike"].isin(strikes)]["symbol"].astype(str).unique().tolist())
    return sub[sub["symbol"].astype(str).isin(chain)].copy(), [str(s) for s in strikes], chain


def module_availability(meta, min_sync_obs=500, min_oos_days=6):
    """Per-module AVAILABLE/UNAVAILABLE with reasons. Never fails the whole engine
    unless basic option data itself is invalid."""
    mods = {}
    ok_data = (meta["n_contracts"] >= 1 and meta["n_timestamps"] > 10
               and meta["synchronized_snapshots"] > 0)
    mods["OPTION_DATA"] = ("AVAILABLE" if ok_data else "UNAVAILABLE",
                           "" if ok_data else "no identifiable contracts/timestamps/prices")
    mods["CHAIN_STRUCTURE"] = mods["OPTION_DATA"]
    sync_ok = meta["synchronized_snapshots"] >= min_sync_obs
    mods["RAW_PRICE"] = ("AVAILABLE" if sync_ok else "UNAVAILABLE",
                         "" if sync_ok else f"only {meta['synchronized_snapshots']} snapshots (< {min_sync_obs})")
    mods["VOLUME"] = mods["RAW_PRICE"]
    mods["OPTION_TYPE_RELATIONSHIP"] = (
        ("AVAILABLE", "") if meta["n_option_types"] >= 2
        else ("UNAVAILABLE", f"only {meta['n_option_types']} option type(s): {meta['option_types']}"))
    mods["STRIKE_RELATIONSHIP"] = (
        ("AVAILABLE", "") if meta["n_strikes"] >= 2
        else ("UNAVAILABLE", f"only {meta['n_strikes']} strike(s)"))
    mods["EXPIRY_RELATIONSHIP"] = (
        ("AVAILABLE", "") if meta["n_expiries"] >= 2
        else ("UNAVAILABLE", f"only {meta['n_expiries']} expir(ies)"))
    mods["LEAD_LAG"] = mods["RAW_PRICE"]
    mods["SEQUENCE"] = mods["RAW_PRICE"]
    mods["CHAIN_STATE"] = mods["RAW_PRICE"]
    mods["EXECUTABLE_MODEL"] = (
        ("AVAILABLE", "") if meta["has_bidask"]
        else ("UNAVAILABLE", "no bid/ask fields; RESEARCH_PRICE_MODEL only"))
    oos_ok = meta["n_days"] >= min_oos_days
    mods["OOS_VALIDATION"] = (
        ("AVAILABLE", "") if oos_ok
        else ("UNAVAILABLE", f"only {meta['n_days']} day(s); VALIDATION_INSUFFICIENT_DATA"))
    return mods


def data_health(norm, meta, chain=None):
    ts = pd.to_datetime(norm["timestamp"])
    uniq = ts.drop_duplicates().sort_values()
    diffs = uniq.diff().dropna()
    missing = 0
    for _, grp in uniq.groupby(uniq.dt.date):
        g = grp.sort_values()
        if len(g) > 1:
            missing += max(0, int(round((g.max() - g.min()).total_seconds() / 60)) + 1 - len(g))
    vol_cov = float((norm["volume"] > 0).mean()) if norm["volume"].notna().any() else 0.0
    # status is judged on the synchronized chain actually analyzed, not on the
    # raw full-contract universe (illiquid contracts may legitimately be sparse)
    if chain:
        per = norm.assign(_c=norm["symbol"].astype(str)).groupby("timestamp")["_c"].apply(
            lambda s: sum(c in set(s.tolist()) for c in chain))
        comp = float((per == len(chain)).mean()) if len(per) else 0.0
    else:
        comp = meta["completeness"]
    status = ("DATA_VALID" if comp >= 0.6 and vol_cov > 0.1 and meta["n_timestamps"] > 100
              else "DATA_PARTIAL" if comp >= 0.3 else "DATA_INVALID")
    return {
        "rows": int(len(norm)), "timestamps": meta["n_timestamps"],
        "unique_days": meta["n_days"], "date_start": meta["timestamp_range"][0],
        "date_end": meta["timestamp_range"][1],
        "interval_distribution": {str(k): int(v) for k, v in diffs.value_counts().head(5).items()},
        "missing_interval_count": int(missing),
        "duplicate_timestamp_count": meta["duplicate_observations"],
        "volume_coverage": round(vol_cov, 4), "status": status,
    }
