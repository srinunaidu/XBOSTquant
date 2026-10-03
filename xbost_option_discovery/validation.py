"""Chronological validation (§17) + clustering (§16) + OOS gate (§31)."""
import pandas as pd

def chronological_splits(days, fractions=(0.5, 0.2, 0.3), embargo_days=0):
    """Configurable chronological discovery/refinement/pseudo-OOS split (§13).

    `embargo_days` (default 0 = backward compatible) drops the trailing
    day(s) of discovery and refinement so parameters are not fitted right
    up against the next fold (serial-correlation guard)."""
    days = sorted(days)
    n = len(days)
    if n < 3:
        return None  # VALIDATION_INSUFFICIENT_DATA
    i1 = max(1, int(n * fractions[0])); i2 = i1 + max(1, int(n * fractions[1]))
    i2 = min(i2, n - 1)
    disc, ref, oos = days[:i1], days[i1:i2], days[i2:]
    emb = max(0, int(embargo_days))
    if emb:
        disc = disc[:-emb] if len(disc) > emb else disc[:1]
        ref = ref[:-emb] if len(ref) > emb else (ref[:1] if ref else [])
    out = {"discovery": disc, "refinement": ref, "pseudo_oos": oos}
    if emb:
        out["embargo_days"] = emb
    return out


def audit_split_integrity(feat, splits, horizon_bars=15):
    """Verify no training-fold row has a label sourced from a later fold.
    Falsifiable no-lookahead check on the OOS split (PASS/FAIL + count)."""
    if not splits or "day" not in feat:
        return {"status": "NOT_APPLICABLE", "violations": 0, "checked_rows": 0}
    day = pd.to_datetime(feat["timestamp"]).dt.date if "timestamp" in feat else feat["day"]
    label_bar = pd.to_datetime(feat["timestamp"]) + pd.Timedelta(minutes=horizon_bars) \
        if "timestamp" in feat else None
    later = set(splits.get("refinement", [])) | set(splits.get("pseudo_oos", []))
    viol = 0
    if label_bar is not None and later:
        reach = label_bar.dt.date.isin(later)
        train = day.isin(set(splits.get("discovery", [])))
        viol = int((train & reach).sum())
    return {"status": "PASS" if viol == 0 else "FAIL", "violations": viol,
            "checked_rows": int(len(feat)), "horizon_bars": horizon_bars,
            "note": "train rows whose forward label reaches into a later fold"}


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
    # symbol-aware clustering (§6): cluster key includes symbol/instrument
    # identity when present so events never cluster across symbols
    sig = sig.copy()
    keys = [k for k in ("symbol_id", "instrument_id", "expiry", "strike", "option_type") if k in sig.columns]
    if not keys:
        keys = ["strike", "option_type"]
    sig = sig.sort_values(keys + ["timestamp"]).copy()
    sig["cluster_id"] = -1
    eid = 0
    for _, grp in sig.groupby(keys):
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
