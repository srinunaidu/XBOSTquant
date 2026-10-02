"""Ingestion (§2) + expiry (§3) + DATA_HEALTH gates (§4). Six-contract synchronized chain."""
import re
import pandas as pd
import numpy as np

WIDE_RE = re.compile(r"^(\d+)(CE|PE)_(o|h|l|c|v)$")
EXPECTED_WIDE = ["54700CE", "54700PE", "54800CE", "54800PE", "54900CE", "54900PE"]

def detect_format(df):
    cols = set(df.columns)
    if {"date", "strike", "otype", "close"}.issubset(cols):
        return "long"
    if [c for c in df.columns if WIDE_RE.match(c)] and ("ts" in cols or "ist" in cols):
        return "wide"
    raise ValueError(f"Unknown format: {list(df.columns)[:15]}")

def load_long(path):
    df = pd.read_csv(path)
    df = df.rename(columns={"date": "timestamp", "otype": "option_type"})
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["strike"] = df["strike"].astype(float).astype(int).astype(str)
    df["option_type"] = df["option_type"].str.upper()
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["expiry"] = df["expiry"].astype(str)
    df["symbol"] = df.get("symbol", df["strike"] + df["option_type"]).astype(str)
    return df[["timestamp", "expiry", "strike", "option_type", "symbol",
               "open", "high", "low", "close", "volume"]].sort_values(
                   ["timestamp", "strike", "option_type"]).reset_index(drop=True)

def load_wide(path):
    df = pd.read_csv(path)
    ts_col = "ts" if "ts" in df.columns else "ist"
    exp_col = "expiry" if "expiry" in df.columns else None
    df["_ts"] = pd.to_datetime(df[ts_col])
    recs = []
    contracts = {}
    for c in df.columns:
        m = WIDE_RE.match(c)
        if m:
            contracts.setdefault((m.group(1), m.group(2)), {})[m.group(3)] = c
    for (strike, otype), mp in contracts.items():
        recs.append(pd.DataFrame({
            "timestamp": df["_ts"],
            "expiry": df[exp_col].astype(str) if exp_col else "UNKNOWN",
            "strike": strike, "option_type": otype,
            "symbol": f"{strike}{otype}",
            "open": pd.to_numeric(df[mp["o"]], errors="coerce") if "o" in mp else np.nan,
            "high": pd.to_numeric(df[mp["h"]], errors="coerce") if "h" in mp else np.nan,
            "low": pd.to_numeric(df[mp["l"]], errors="coerce") if "l" in mp else np.nan,
            "close": pd.to_numeric(df[mp["c"]], errors="coerce") if "c" in mp else np.nan,
            "volume": pd.to_numeric(df[mp["v"]], errors="coerce") if "v" in mp else np.nan,
        }))
    out = pd.concat(recs, ignore_index=True).sort_values(
        ["timestamp", "strike", "option_type"]).reset_index(drop=True)
    return out

def load_dataset(path):
    peek = pd.read_csv(path, nrows=5)
    fmt = detect_format(peek)
    norm = load_long(path) if fmt == "long" else load_wide(path)
    return norm, fmt

def select_chain(norm, n_strikes=3):
    """Synchronized 6-contract chain: top-n strikes by volume -> n*2 contracts."""
    vol = norm.groupby("strike")["volume"].sum().sort_values(ascending=False)
    strikes = [str(s) for s in vol.head(n_strikes).index.tolist()]
    chain = sorted([s + t for s in strikes for t in ["CE", "PE"]])
    sub = norm[norm["strike"].astype(str).isin(strikes)].copy()
    return sub, strikes, chain

def data_health(norm, chain_contracts):
    ts = pd.to_datetime(norm["timestamp"])
    uniq = ts.drop_duplicates().sort_values()
    diffs = uniq.diff().dropna()
    exp_iv = pd.Timedelta("1min")
    missing = 0
    for _, grp in uniq.groupby(uniq.dt.date):
        g = grp.sort_values()
        if len(g) > 1:
            missing += max(0, int(round((g.max() - g.min()).total_seconds() / 60)) + 1 - len(g))
    # chain completeness: fraction of timestamps with all 6 contracts
    present = norm.assign(c=norm["strike"].astype(str) + norm["option_type"])
    per_ts = present.groupby("timestamp")["c"].apply(lambda s: sum(c in s.values for c in chain_contracts))
    completeness = float((per_ts == len(chain_contracts)).mean()) if len(per_ts) else 0.0
    vol_cov = float((norm["volume"] > 0).mean())
    dup = int(norm.duplicated(subset=["timestamp", "strike", "option_type"]).sum())
    expiries = sorted(norm["expiry"].astype(str).unique().tolist())
    strikes = sorted(norm["strike"].astype(str).unique().tolist())
    health = {
        "rows": int(len(norm)), "timestamps": int(uniq.nunique()),
        "unique_days": int(uniq.dt.date.nunique()),
        "date_start": str(uniq.min()), "date_end": str(uniq.max()),
        "interval_distribution": diffs.value_counts().head(5).to_dict(),
        "expected_interval": "1min",
        "missing_interval_count": int(missing),
        "duplicate_timestamp_count": dup,
        "contracts": sorted((norm["strike"].astype(str) + norm["option_type"]).unique().tolist()),
        "contracts_loaded": len(chain_contracts),
        "chain_contracts": chain_contracts,
        "strikes": strikes, "option_types": sorted(norm["option_type"].unique().tolist()),
        "expiries": expiries, "n_expiries": len(expiries),
        "chain_completeness": round(completeness, 4),
        "volume_coverage": round(vol_cov, 4),
    }
    if completeness >= 0.95 and vol_cov > 0.1 and health["timestamps"] > 100:
        health["status"] = "DATA_VALID"
    elif completeness >= 0.5:
        health["status"] = "DATA_PARTIAL"
    else:
        health["status"] = "DATA_INVALID"
    return health
