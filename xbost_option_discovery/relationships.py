"""Dynamic relationships: OPTION_TYPE / STRIKE / breadth. Driven by chain_metadata.
Only generates relationship types the dataset supports. Column names embed the
discovered type tokens as data values (registry returned for downstream use)."""
import pandas as pd
import numpy as np

REL_COUNT = {"n": 0}
REGISTRY = {"type_pair": None, "type_cols": [], "x_cols": [], "breadth_cols": []}


def add_type_relationship(df, meta):
    """Pairwise relationship between the two most-liquid option types (whatever they are)."""
    df = df.copy()
    REGISTRY["type_cols"] = []
    otypes = list(meta["option_types"])
    if len(otypes) < 2:
        return df
    vol = df.groupby("option_type")["volume"].sum().sort_values(ascending=False)
    t0, t1 = str(vol.index[0]), str(vol.index[1])
    REGISTRY["type_pair"] = (t0, t1)
    a = df[df["option_type"] == t0][["timestamp", "expiry", "strike", "return_1", "return_5",
                                     "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "t0_r1", "return_5": "t0_r5", "accel_1_3": "t0_acc",
                 "volume": "t0_vol", "range": "t0_rng"})
    b = df[df["option_type"] == t1][["timestamp", "expiry", "strike", "return_1", "return_5",
                                     "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "t1_r1", "return_5": "t1_r5", "accel_1_3": "t1_acc",
                 "volume": "t1_vol", "range": "t1_rng"})
    m = pd.merge(a, b, on=["timestamp", "expiry", "strike"], how="inner")
    m["type_ret_diff"] = m["t0_r5"] - m["t1_r5"]
    m["type_ret_ratio"] = m["t0_r5"] / m["t1_r5"].replace(0, np.nan)
    m["type_vol_ratio"] = m["t0_vol"] / m["t1_vol"].replace(0, np.nan)
    m["type_vol_diff"] = m["t0_vol"] - m["t1_vol"]
    m["type_range_diff"] = m["t0_rng"] - m["t1_rng"]
    m["type_acc_diff"] = m["t0_acc"] - m["t1_acc"]
    m[f"ev_{t0}_leads_{t1}"] = ((m["t0_r5"].abs() > 1.5) & (m["t1_r5"].abs() < 0.5)).astype(float)
    m[f"ev_{t1}_leads_{t0}"] = ((m["t1_r5"].abs() > 1.5) & (m["t0_r5"].abs() < 0.5)).astype(float)
    m[f"ev_{t0}_accel_{t1}_stall"] = ((m["t0_acc"].abs() > 1.0) & (m["t1_acc"].abs() < 0.3)).astype(float)
    m[f"ev_{t1}_accel_{t0}_stall"] = ((m["t1_acc"].abs() > 1.0) & (m["t0_acc"].abs() < 0.3)).astype(float)
    # legacy alias kept for continuity of downstream generic readers
    m["cepe_ret_diff"] = m["type_ret_diff"]
    m["cepe_acc_diff"] = m["type_acc_diff"]
    keep = ["type_ret_diff", "type_ret_ratio", "type_vol_ratio", "type_vol_diff",
            "type_range_diff", "type_acc_diff", "cepe_ret_diff", "cepe_acc_diff",
            f"ev_{t0}_leads_{t1}", f"ev_{t1}_leads_{t0}",
            f"ev_{t0}_accel_{t1}_stall", f"ev_{t1}_accel_{t0}_stall"]
    REGISTRY["type_cols"] = keep
    lut = m.set_index(["timestamp", "expiry", "strike"])[keep]
    # dedupe guard: same (ts,expiry,strike) twice would fan out the join
    lut = lut[~lut.index.duplicated(keep="first")]
    df = df.join(lut, on=["timestamp", "expiry", "strike"])
    df["type_pair"] = f"{t0}/{t1}"
    REL_COUNT["n"] += len(keep)
    return df


def add_crossstrike(df, meta, strikes):
    """Per-option-type, per-expiry strike spreads for every discovered option type."""
    df = df.copy()
    REGISTRY["x_cols"] = []
    REGISTRY["x_failures"] = []
    strikes = [str(s) for s in strikes]
    new_cols = {}
    for exp, gexp in df.groupby(df["expiry"].astype(str)):
        tag = "" if len(meta["expiries"]) <= 1 else f"_{exp}"
        for otype in meta["option_types"]:
            sub = gexp[gexp["option_type"] == otype][["timestamp", "strike", "return_5",
                                                      "accel_1_3", "volume", "range"]].copy()
            sub["strike"] = sub["strike"].astype(str)  # key-normalize: pivot cols are strings
            for f, fn in [("return_5", "retdiff"), ("accel_1_3", "accdiff"),
                          ("volume", "volspread"), ("range", "rngspread")]:
                try:
                    wp = sub.pivot_table(index="timestamp", columns="strike", values=f, aggfunc="first")
                except Exception as ex:
                    REGISTRY["x_failures"].append(f"{otype}{tag}:{fn}:{type(ex).__name__}")
                    continue
                for i in range(len(strikes)):
                    for j in range(i + 1, len(strikes)):
                        sa, sb = str(strikes[i]), str(strikes[j])
                        if sa in wp.columns and sb in wp.columns:
                            col = f"x_{otype}_{sa}_{sb}_{fn}{tag}"
                            spread = wp[sa] - wp[sb]
                            # Assign ONLY to this (expiry, option-type) group:
                            # writing ts.map(spread) across the frame would smear
                            # expiry A's spread onto expiry B rows.
                            vals = pd.Series(np.nan, index=df.index, dtype="float64")
                            vals.loc[gexp.index] = pd.Index(
                                gexp["timestamp"]).map(spread).to_numpy()
                            new_cols[col] = vals
                            REGISTRY["x_cols"].append(col)
                            REL_COUNT["n"] += 1
    # concat ONCE: assigning each spread column individually fragments the
    # frame (DataFrame is highly fragmented) and dominated pipeline runtime.
    if new_cols:
        df = pd.concat([df, pd.DataFrame(new_cols, index=df.index)], axis=1)
    return df


def add_breadth(df, meta):
    """Breadth over every discovered option type (no fixed CE/PE assumption).

    Breadth is a PERCENTAGE of contracts present at that timestamp (raw
    counts kept as *_breadth / breadth_diff_count for audit); count
    denominators change through the session, so count-diffs are not
    comparable across timestamps."""
    df = df.copy()
    REGISTRY["breadth_cols"] = []
    otypes = list(meta["option_types"])

    def _b(g):
        out = {}
        for ot in otypes:
            r = g.loc[g["option_type"] == ot, "return_5"].dropna()
            out[f"{ot}_n"] = int(len(r))
            out[f"{ot}_basket_ret"] = float(r.mean()) if len(r) else np.nan
            out[f"{ot}_breadth"] = int((r > 0).sum())
            out[f"{ot}_breadth_pct"] = float((r > 0).mean() * 100.0) if len(r) else np.nan
            out[f"{ot}_vol_breadth"] = int((g.loc[g["option_type"] == ot, "volume_percentile"] > 70).sum()) if "volume_percentile" in g else 0
        if len(otypes) >= 2:
            o0, o1 = otypes[0], otypes[1]
            b0, b1 = out.get(f"{o0}_breadth_pct"), out.get(f"{o1}_breadth_pct")
            out["breadth_diff"] = (b0 - b1) if (pd.notna(b0) and pd.notna(b1)) else np.nan
            out["breadth_diff_count"] = out.get(f"{o0}_breadth", 0) - out.get(f"{o1}_breadth", 0)
        else:
            out["breadth_diff"] = np.nan
            out["breadth_diff_count"] = 0
        return pd.Series(out)

    b = df.groupby("timestamp").apply(_b, include_groups=False)
    REGISTRY["breadth_cols"] = list(b.columns)
    df = df.join(b, on="timestamp")
    REL_COUNT["n"] += len(b.columns)
    return df
