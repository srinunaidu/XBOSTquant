"""Data loading: supports BOTH wide-format (spec §2) and long-format (repo).
Wide: ts,ist,expiry + {strike}{CE|PE}_{o,h,l,c,v}  e.g. 54700CE_o
Long: date,symbol,strike,otype,expiry,open,high,low,close,volume
Output normalized: timestamp,expiry,strike,option_type,open,high,low,close,volume
Keeps wide pivot available for cross-strike calcs. No forward-fill (spec §3).
"""
import hashlib
import re
import pandas as pd
import numpy as np

WIDE_RE = re.compile(r"^(\d+)(CE|PE)_(o|h|l|c|v)$")

def dataset_hash(df: pd.DataFrame) -> str:
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=True).values.tobytes()).hexdigest()[:16]

def detect_format(df: pd.DataFrame) -> str:
    cols = set(df.columns)
    if {"date", "strike", "otype", "close"}.issubset(cols):
        return "long"
    wide_hits = [c for c in df.columns if WIDE_RE.match(c)]
    if wide_hits and ("ts" in cols or "ist" in cols):
        return "wide"
    raise ValueError(f"Unknown dataset format. Columns: {list(df.columns)[:15]}")

def load_long(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    # normalize column names
    df = df.rename(columns={"date": "timestamp", "otype": "option_type"})
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["strike"] = df["strike"].astype(float).astype(int).astype(str)
    df["option_type"] = df["option_type"].str.upper()
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["expiry"] = df["expiry"].astype(str)
    out = df[["timestamp", "expiry", "strike", "option_type",
              "open", "high", "low", "close", "volume"]].copy()
    out = out.sort_values(["timestamp", "strike", "option_type"]).reset_index(drop=True)
    return out

def load_wide(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    ts_col = "ts" if "ts" in df.columns else "ist"
    df["_timestamp"] = pd.to_datetime(df[ts_col])
    # expiry column may be single value or per-row
    exp_col = "expiry" if "expiry" in df.columns else None
    records = []
    wide_cols = [c for c in df.columns if WIDE_RE.match(c)]
    # group by contract
    contracts = {}
    for c in wide_cols:
        m = WIDE_RE.match(c)
        strike, otype, fld = m.group(1), m.group(2), m.group(3)
        contracts.setdefault((strike, otype), {})[fld] = c
    for (strike, otype), mp in contracts.items():
        sub = pd.DataFrame({
            "timestamp": df["_timestamp"],
            "expiry": df[exp_col].astype(str) if exp_col else "UNKNOWN",
            "strike": strike,
            "option_type": otype,
            "open": df[mp.get("o")] if "o" in mp else np.nan,
            "high": df[mp.get("h")] if "h" in mp else np.nan,
            "low": df[mp.get("l")] if "l" in mp else np.nan,
            "close": df[mp.get("c")] if "c" in mp else np.nan,
            "volume": df[mp.get("v")] if "v" in mp else np.nan,
        })
        records.append(sub)
    out = pd.concat(records, ignore_index=True)
    out = out.sort_values(["timestamp", "strike", "option_type"]).reset_index(drop=True)
    return out

def load_dataset(path: str):
    raw = pd.read_csv(path, nrows=5)
    fmt = detect_format(raw)
    if fmt == "long":
        norm = load_long(path)
    else:
        norm = load_wide(path)
    return norm, fmt

def pivot_wide(norm: pd.DataFrame, field: str = "close") -> pd.DataFrame:
    """Wide pivot indexed by timestamp, columns = {strike}{otype}. No fill."""
    norm = norm.copy()
    norm["contract"] = norm["strike"].astype(str) + norm["option_type"]
    wide = norm.pivot_table(index="timestamp", columns="contract",
                            values=field, aggfunc="first")
    return wide.sort_index()

def focus_strikes(norm: pd.DataFrame, n: int = 3) -> list:
    """Top-N strikes by total volume (for long-format chain focus)."""
    vol = norm.groupby("strike")["volume"].sum().sort_values(ascending=False)
    return [str(s) for s in vol.head(n).index.tolist()]
