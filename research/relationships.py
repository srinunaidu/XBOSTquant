"""CE-vs-PE (§10) and cross-strike (§9) relationships. Synchronized snapshots only."""
import pandas as pd
import numpy as np

def add_cepe_crossstrike(feat: pd.DataFrame, focus_strikes: list) -> pd.DataFrame:
    df = feat.copy()
    # pivot key fields by contract for snapshot joins
    piv_ret = df.pivot_table(index="timestamp", columns=df["strike"].astype(str) + df["option_type"],
                             values="return_5", aggfunc="first")
    piv_acc = df.pivot_table(index="timestamp", columns=df["strike"].astype(str) + df["option_type"],
                             values="accel_5_15", aggfunc="first")
    piv_vol = df.pivot_table(index="timestamp", columns=df["strike"].astype(str) + df["option_type"],
                             values="vol_ratio", aggfunc="first")
    piv_close = df.pivot_table(index="timestamp", columns=df["strike"].astype(str) + df["option_type"],
                               values="close", aggfunc="first")
    ts = df["timestamp"]
    # CE-PE per strike (only for strikes present)
    strikes = sorted(df["strike"].astype(str).unique().tolist())
    cepe_ret, cepe_acc, cepe_volr = {}, {}, {}
    for s in strikes:
        ce, pe = f"{s}CE", f"{s}PE"
        if ce in piv_ret.columns and pe in piv_ret.columns:
            cepe_ret[s] = (piv_ret[ce] - piv_ret[pe]).reindex(ts).values \
                if False else None  # placeholder
    # vectorized per-row using merges (simpler + exact sync):
    ce = df[df["option_type"] == "CE"][["timestamp", "strike", "return_5", "accel_5_15", "vol_ratio", "close"]].rename(
        columns={"return_5": "ce_ret5", "accel_5_15": "ce_acc", "vol_ratio": "ce_volr", "close": "ce_close"})
    pe = df[df["option_type"] == "PE"][["timestamp", "strike", "return_5", "accel_5_15", "vol_ratio", "close"]].rename(
        columns={"return_5": "pe_ret5", "accel_5_15": "pe_acc", "vol_ratio": "pe_volr", "close": "pe_close"})
    m = pd.merge(ce, pe, on=["timestamp", "strike"], how="inner", suffixes=("", ""))
    m["cepe_ret_diff"] = m["ce_ret5"] - m["pe_ret5"]
    m["cepe_acc_diff"] = m["ce_acc"] - m["pe_acc"]
    m["cepe_vol_ratio"] = m["ce_volr"] / m["pe_volr"].replace(0, np.nan)
    m["cepe_divergence"] = m["cepe_ret_diff"].abs()
    m["simultaneous_expansion"] = ((m["ce_ret5"].abs() > 1.0) & (m["pe_ret5"].abs() > 1.0)).astype(float)
    lut = m.set_index(["timestamp", "strike"])[["cepe_ret_diff", "cepe_acc_diff",
                                                  "cepe_vol_ratio", "cepe_divergence",
                                                  "simultaneous_expansion"]]
    df = df.join(lut, on=["timestamp", "strike"])
    # cross-strike: for focus strikes, CE and PE separately — return/accel/volume diffs vs neighbors
    for otype in ["CE", "PE"]:
        fs = [s for s in focus_strikes]
        sub = df[df["option_type"] == otype][["timestamp", "strike", "return_5", "accel_5_15", "vol_ratio", "close"]]
        wp = sub.pivot_table(index="timestamp", columns="strike", values=["return_5", "accel_5_15", "vol_ratio", "close"], aggfunc="first")
        # pairwise diffs among focus strikes
        for i in range(len(fs)):
            for j in range(i + 1, len(fs)):
                a, b = str(fs[i]), str(fs[j])
                try:
                    ra = wp[("return_5", a)]; rb = wp[("return_5", b)]
                    diff = (ra - rb)
                    df[f"x_{otype}_{a}_{b}_retdiff"] = ts.map(diff)
                    aa = wp[("accel_5_15", a)]; ab = wp[("accel_5_15", b)]
                    df[f"x_{otype}_{a}_{b}_accdiff"] = ts.map(aa - ab)
                    va = wp[("vol_ratio", a)]; vb = wp[("vol_ratio", b)]
                    df[f"x_{otype}_{a}_{b}_volratio"] = ts.map(va / vb.replace(0, np.nan))
                    pa = wp[("close", a)]; pb = wp[("close", b)]
                    df[f"x_{otype}_{a}_{b}_priceratio"] = ts.map(pa / pb.replace(0, np.nan))
                except KeyError:
                    continue
    return df
