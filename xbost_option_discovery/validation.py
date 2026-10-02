"""Chronological validation (§17) + clustering (§16) + OOS gate (§31)."""
import pandas as pd

def chronological_splits(days, fractions=(0.5, 0.2, 0.3)):
    """Configurable chronological discovery/refinement/pseudo-OOS split (§13)."""
    days = sorted(days)
    n = len(days)
    if n < 3:
        return None  # VALIDATION_INSUFFICIENT_DATA
    i1 = max(1, int(n * fractions[0])); i2 = i1 + max(1, int(n * fractions[1]))
    i2 = min(i2, n - 1)
    return {"discovery": days[:i1], "refinement": days[i1:i2], "pseudo_oos": days[i2:]}


def splits_50_20_30(days):
    return chronological_splits(days, (0.5, 0.2, 0.3))

def walk_forward(days, train_n=8, test_n=3):
    days = sorted(days)
    out = []
    i = 0
    while i + train_n + test_n <= len(days):
        out.append({"train": days[i:i + train_n], "test": days[i + train_n:i + train_n + test_n]})
        i += test_n
    return out

def cluster(sig, minutes=3):
    sig = sig.sort_values(["strike", "option_type", "timestamp"]).copy()
    sig["cluster_id"] = -1
    eid = 0
    for _, grp in sig.groupby(["strike", "option_type"]):
        last = None; cur = -1
        for i, t in zip(grp.index, pd.to_datetime(grp["timestamp"])):
            if last is None or (t - last).total_seconds() / 60 > minutes:
                eid += 1; cur = eid
            sig.loc[i, "cluster_id"] = cur
            last = t
    return sig

def oos_gate(n_oos, min_oos=20):
    if n_oos < 6:
        return "THIN_OOS"
    if n_oos < min_oos:
        return "THIN_OOS"
    return "OOS_OK"
