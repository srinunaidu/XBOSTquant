"""CE/PE (§8) + cross-strike (§9) + chain breadth (§10). Synchronized only."""
import pandas as pd
import numpy as np

REL_COUNT = {"n": 0}

def add_cepe(df):
    df = df.copy()
    ce = df[df["option_type"] == "CE"][["timestamp", "strike", "return_1", "return_5", "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "ce_r1", "return_5": "ce_r5", "accel_1_3": "ce_acc", "volume": "ce_vol", "range": "ce_rng"})
    pe = df[df["option_type"] == "PE"][["timestamp", "strike", "return_1", "return_5", "accel_1_3", "volume", "range"]].rename(
        columns={"return_1": "pe_r1", "return_5": "pe_r5", "accel_1_3": "pe_acc", "volume": "pe_vol", "range": "pe_rng"})
    m = pd.merge(ce, pe, on=["timestamp", "strike"], how="inner")
    m["cepe_ret_diff"] = m["ce_r5"] - m["pe_r5"]
    m["cepe_ret_ratio"] = m["ce_r5"] / m["pe_r5"].replace(0, np.nan)
    m["cepe_vol_ratio"] = m["ce_vol"] / m["pe_vol"].replace(0, np.nan)
    m["cepe_vol_diff"] = m["ce_vol"] - m["pe_vol"]
    m["cepe_range_diff"] = m["ce_rng"] - m["pe_rng"]
    m["cepe_acc_diff"] = m["ce_acc"] - m["pe_acc"]
    m["ev_ce_leads_pe"] = ((m["ce_r5"].abs() > 1.5) & (m["pe_r5"].abs() < 0.5)).astype(float)
    m["ev_pe_leads_ce"] = ((m["pe_r5"].abs() > 1.5) & (m["ce_r5"].abs() < 0.5)).astype(float)
    m["ev_ce_accel_pe_stall"] = ((m["ce_acc"].abs() > 1.0) & (m["pe_acc"].abs() < 0.3)).astype(float)
    m["ev_pe_accel_ce_stall"] = ((m["pe_acc"].abs() > 1.0) & (m["ce_acc"].abs() < 0.3)).astype(float)
    lut = m.set_index(["timestamp", "strike"])
    df = df.join(lut, on=["timestamp", "strike"], rsuffix="_cepe")
    REL_COUNT["n"] += 10
    return df

def add_crossstrike(df, strikes):
    df = df.copy()
    ts = df["timestamp"]
    for otype in ["CE", "PE"]:
        sub = df[df["option_type"] == otype][["timestamp", "strike", "return_5", "accel_1_3", "volume", "range", "close"]]
        for f, fn in [("return_5", "retdiff"), ("accel_1_3", "accdiff")]:
            try:
                wp = sub.pivot_table(index="timestamp", columns="strike", values=f, aggfunc="first")
                for i in range(len(strikes)):
                    for j in range(i + 1, len(strikes)):
                        a, b = str(strikes[i]), str(strikes[j])
                        if a in wp.columns and b in wp.columns:
                            df[f"x_{otype}_{a}_{b}_{fn}"] = ts.map(wp[a] - wp[b])
                            REL_COUNT["n"] += 1
            except Exception:
                continue
        for f, fn in [("volume", "volspread"), ("range", "rngspread")]:
            try:
                wp = sub.pivot_table(index="timestamp", columns="strike", values=f, aggfunc="first")
                for i in range(len(strikes)):
                    for j in range(i + 1, len(strikes)):
                        a, b = str(strikes[i]), str(strikes[j])
                        if a in wp.columns and b in wp.columns:
                            df[f"x_{otype}_{a}_{b}_{fn}"] = ts.map(wp[a] - wp[b])
                            REL_COUNT["n"] += 1
            except Exception:
                continue
    return df

def add_breadth(df):
    """Chain breadth (§10): CE/PE basket return, momentum, breadth counts."""
    df = df.copy()
    br = df.groupby("timestamp").agg(
        ce_n=("option_type", lambda s: int((s == "CE").sum())),
        ce_up=("return_5", lambda s: 0),
    )
    # per-timestamp breadth computed from synchronized rows
    def _b(g):
        ce = g[g["option_type"] == "CE"]; pe = g[g["option_type"] == "PE"]
        return pd.Series({
            "ce_basket_ret": ce["return_5"].mean(), "pe_basket_ret": pe["return_5"].mean(),
            "ce_breadth": (ce["return_5"] > 0).sum(), "pe_breadth": (pe["return_5"] > 0).sum(),
            "ce_vol_breadth": (ce["volume_percentile"] > 70).sum() if "volume_percentile" in ce else 0,
            "pe_vol_breadth": (pe["volume_percentile"] > 70).sum() if "volume_percentile" in pe else 0,
        })
    b = df.groupby("timestamp").apply(_b, include_groups=False)
    b["breadth_diff"] = b["ce_breadth"] - b["pe_breadth"]
    df = df.join(b, on="timestamp")
    REL_COUNT["n"] += 7
    return df
