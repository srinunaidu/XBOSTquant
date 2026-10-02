"""Chain normalizer (§2): normalized + wide snapshot + audit. No forward-fill."""
import pandas as pd

def normalize(norm):
    return norm.sort_values(["timestamp", "strike", "option_type"]).reset_index(drop=True)

def snapshot(norm, timestamp):
    return norm[norm["timestamp"] == timestamp].set_index(
        norm["strike"].astype(str) + norm["option_type"])

def audit_contracts(norm, expected=None):
    have = sorted((norm["strike"].astype(str) + norm["option_type"]).unique().tolist())
    lines = [f"contracts_loaded = {len(have)}"]
    for c in have:
        lines.append(f"  {c}")
    if expected:
        missing = [c for c in expected if c not in have]
        for c in missing:
            lines.append(f"  MISSING: {c}")
    return have, "\n".join(lines)

def audit_expiry(norm):
    exps = sorted(norm["expiry"].astype(str).unique().tolist())
    out = [f"EXPIRIES={len(exps)}"]
    for e in exps:
        n = int((norm["expiry"].astype(str) == e).sum())
        out.append(f"  expiry {e}: rows={n} expiry_loaded={'1' if n else '0'}")
        if n == 0:
            out.append(f"  expiry_loaded = 0 ({e} excluded)")
    out.append("MULTI_EXPIRY=NOT_AVAILABLE" if len(exps) <= 1 else "MULTI_EXPIRY=AVAILABLE")
    return exps, "\n".join(out)
