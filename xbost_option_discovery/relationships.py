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
    a = df[df["option_type"] == t0][["timestamp", "strike", "return_1", "return_5",
                                     "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "t0_r1", "return_5": "t0_r5", "accel_1_3": "t0_acc",
                 "volume": "t0_vol", "range": "t0_rng"})
    b = df[df["option_type"] == t1][["timestamp", "strike", "return_1", "return_5",
                                     "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "t1_r1", "return_5": "t1_r5", "accel_1_3": "t1_acc",
                 "volume": "t1_vol", "range": "t1_rng"})
    m = pd.merge(a, b, on=["timestamp", "strike"], how="inner")
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
    lut = m.set_index(["timestamp", "strike"])[keep]
    df = df.join(lut, on=["timestamp", "strike"])
    df["type_pair"] = f"{t0}/{t1}"
    REL_COUNT["n"] += len(keep)
    return df


def add_crossstrike(df, meta, strikes):
    """Per-option-type strike spreads for every discovered option type."""
    df = df.copy()
    REGISTRY["x_cols"] = []
    ts = df["timestamp"]
    strikes = [str(s) for s in strikes]
    for otype in meta["option_types"]:
        sub = df[df["option_type"] == otype][["timestamp", "strike", "return_5",
                                              "accel_1_3", "volume", "range"]].copy()
        sub["strike"] = sub["strike"].astype(str)  # key-normalize: pivot cols are strings
        for f, fn in [("return_5", "retdiff"), ("accel_1_3", "accdiff"),
                      ("volume", "volspread"), ("range", "rngspread")]:
            try:
                wp = sub.pivot_table(index="timestamp", columns="strike", values=f, aggfunc="first")
                for i in range(len(strikes)):
                    for j in range(i + 1, len(strikes)):
                        sa, sb = str(strikes[i]), str(strikes[j])
                        if sa in wp.columns and sb in wp.columns:
                            col = f"x_{otype}_{sa}_{sb}_{fn}"
                            df[col] = ts.map(wp[sa] - wp[sb])
                            REGISTRY["x_cols"].append(col)
                            REL_COUNT["n"] += 1
            except Exception:
                continue
    return df


def add_breadth(df, meta):
    """Breadth over every discovered option type (no fixed CE/PE assumption)."""
    df = df.copy()
    REGISTRY["breadth_cols"] = []

    def _b(g):
        out = {}
        for ot in meta["option_types"]:
            s = g[g["option_type"] == ot]
            out[f"{ot}_basket_ret"] = s["return_5"].mean()
            out[f"{ot}_breadth"] = (s["return_5"] > 0).sum()
            out[f"{ot}_vol_breadth"] = (s["volume_percentile"] > 70).sum() if "volume_percentile" in s else 0
        if len(meta["option_types"]) >= 2:
            o0, o1 = meta["option_types"][0], meta["option_types"][1]
            out["breadth_diff"] = out.get(f"{o0}_breadth", 0) - out.get(f"{o1}_breadth", 0)
        else:
            out["breadth_diff"] = 0
        return pd.Series(out)

    b = df.groupby("timestamp").apply(_b, include_groups=False)
    REGISTRY["breadth_cols"] = list(b.columns)
    df = df.join(b, on="timestamp")
    REL_COUNT["n"] += len(b.columns)
    return df
