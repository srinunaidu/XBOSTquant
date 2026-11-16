"""Chronological validation (§17) + clustering (§16) + OOS gate (§31)."""
import pandas as pd

IST_OFFSET_MS = 19800000
MIN_SESSIONS = 50
MIN_EXPIRIES = 3
MIN_CONTRACTS = 10
MAX_SCOPE_CONTRACTS = 8

def assess_data_health(sessions, expiries, contracts):
    ok = sessions >= MIN_SESSIONS and expiries >= MIN_EXPIRIES and contracts >= MIN_CONTRACTS
    reason = None if ok else f"DATA_INSUFFICIENT sessions={sessions} expiries={expiries} contracts={contracts}"
    return {"sessions": sessions, "expiries": expiries, "contracts": contracts, "ok": ok, "reason": reason, "blocked": not ok}

def validate_data_health(sessions, expiries, contracts):
    dh = assess_data_health(sessions, expiries, contracts)
    if not dh["ok"]:
        print(f"[DATA_INSUFFICIENT] sessions={sessions} expiries={expiries} contracts={contracts}")
    return dh

def expiry_guard(carry, exclude_expiry):
    if carry and exclude_expiry:
        return {"blocked": True, "reason": "EXPIRY_GUARD", "paperReady": False}
    return {"blocked": False, "paperReady": True}

def iv_gate(iv_rank, iv_max_rank=0.3, iv_mode="block"):
    if iv_rank is None:
        return {"insufficient": False, "blocked": False, "paperReady": True}
    if iv_rank > iv_max_rank:
        if iv_mode == "block":
            print(f"[IV_INSUFFICIENT] ivRank={iv_rank}")
            return {"insufficient": True, "blocked": True, "paperReady": False, "reason": "IV_RANK_INSUFFICIENT"}
        return {"insufficient": True, "blocked": False, "paperReady": True, "warning": f"IV_INSUFFICIENT ivRank={iv_rank}"}
    return {"insufficient": False, "blocked": False, "paperReady": True}

def validate_scope(scope):
    if scope is None:
        return {"scope": [], "truncated": False}
    if len(scope) > MAX_SCOPE_CONTRACTS:
        return {"scope": scope[:MAX_SCOPE_CONTRACTS], "truncated": True, "blocked": False}
    return {"scope": scope, "truncated": False}

def validate_paper_ready(sessions, expiries, contracts, carry=False, exclude_expiry=False, iv_rank=None, iv_max_rank=0.3, iv_mode="block", top1_pct=None, fallback_days=None, max_conf=None, conf_gate=0.6):
    reasons=[]
    dh = assess_data_health(sessions, expiries, contracts)
    if not dh["ok"]:
        reasons.append(dh["reason"])
    eg = expiry_guard(carry, exclude_expiry)
    if eg["blocked"]:
        reasons.append(eg["reason"])
    iv = iv_gate(iv_rank, iv_max_rank, iv_mode)
    if iv["blocked"]:
        reasons.append(iv["reason"])
    if top1_pct is not None and top1_pct >= 0.40:
        reasons.append("TOP1_PCT_GTE_40")
    if fallback_days is not None and sessions is not None:
        ratio = fallback_days/sessions if sessions else 0
        mc = max_conf if max_conf is not None else 1
        if ratio > 0.30 and mc < conf_gate:
            reasons.append("LOW_REGIME_CONFIDENCE")
    paperReady = len(reasons)==0
    return {"paperReady": paperReady, "blocked": not paperReady, "reasons": reasons}

# slippage validation tag G1
def validate_slippage(slippage_model, spread_ticks=1, atr_mult=0.05):
    if slippage_model not in ("none","spread","atr"):
        return {"ok": False, "reason": "invalid slippageModel"}
    return {"ok": True, "model": slippage_model, "tag": "G1"}


def validate_session_anchor(session_anchor):
    if session_anchor not in ("wall","session"):
        return {"ok": False, "reason": "invalid sessionAnchor"}
    return {"ok": True, "anchor": session_anchor}

def validate_sizing(sizing, risk_pct=0.5, atr_period=14, max_concurrent=1, corr_cap=0.7):
    if sizing not in ("fixed","volTarget","kelly"):
        return {"ok": False, "reason": "invalid sizing"}
    if not (0 < risk_pct <= 5):
        return {"ok": False, "reason": "riskPct out of range"}
    if not (1 <= atr_period <= 100):
        return {"ok": False, "reason": "atrPeriod out of range"}
    if max_concurrent < 1:
        return {"ok": False, "reason": "maxConcurrent <1"}
    if not (0 < corr_cap <= 1):
        return {"ok": False, "reason": "corrCap out of range"}
    return {"ok": True, "sizing": sizing, "riskPct": risk_pct, "atrPeriod": atr_period, "maxConcurrent": max_concurrent, "corrCap": corr_cap}

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
    label_bar = pd.to_datetime(feat["timestamp"]) + pd.Timedelta(minutes=horizon_bars)         if "timestamp" in feat else None
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
