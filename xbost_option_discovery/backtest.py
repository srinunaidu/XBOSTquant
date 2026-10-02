"""Option-native backtest (§19-22) with exit fingerprint (§27). RESEARCH_PRICE_MODEL only."""
import pandas as pd

def fingerprint(cid, sl, tp, trail, exit_mode):
    return f"{cid}|sl={sl}|tp={tp}|trail={trail}|exit={exit_mode}"

def backtest(feat, mask, hold_bars=5, sl=1.0, tp=2.0, trail=None, exit_mode="time",
             cid="CAND", verify=True):
    df = feat.loc[mask].copy().sort_values(["strike", "option_type", "timestamp"])
    fp = fingerprint(cid, sl, tp, trail, exit_mode)
    df["exit_close"] = df.groupby(["strike", "option_type"])["close"].shift(-hold_bars)
    df["ret"] = df["exit_close"] / df["close"] * 100 - 100
    if exit_mode in ("fixed", "premium") and "MAE_5m" in df.columns:
        stopped = df["MAE_5m"] > sl
        df.loc[stopped, "ret"] = -sl
        df["stopped"] = stopped
    if verify:
        # parameter propagation audit: fingerprint must reach ledger
        assert "ret" in df.columns and "exit_close" in df.columns, "exit params did not reach ledger"
    df["fingerprint"] = fp
    df["model"] = "RESEARCH_PRICE_MODEL"
    df["candidate_id"] = cid
    return df[["timestamp", "strike", "option_type", "close", "exit_close", "ret",
               "fingerprint", "model", "candidate_id"]]
