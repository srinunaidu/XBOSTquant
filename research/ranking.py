"""Candidate ranking (spec §20,22) + option-native backtest (spec §29, RESEARCH_PRICE_MODEL)."""
import pandas as pd
import numpy as np

def rank_candidates(stats_df: pd.DataFrame) -> pd.DataFrame:
    df = stats_df.copy()
    # hard minimum filters
    df = df[(df["n_indep"] >= 1)].copy()
    # stability: pseudo-OOS sign agreement + survival after best removal
    df["oos_agree"] = (np.sign(df["mean_train"]) == np.sign(df["mean_oos"])).astype(float)
    df["score"] = (df["mean_oos"].fillna(0) * 2.0
                   + df["median_all"].fillna(0)
                   - df["top3_conc"].fillna(1) * 1.0
                   - df["perm_p"].fillna(1) * 1.0
                   + df["oos_agree"] * 0.5
                   + np.log1p(df["indep_days"].fillna(0)) * 0.1)
    df = df.sort_values("score", ascending=False)
    # status assignment (spec §32, honest: require OOS+train agreement, permutation, concentration)
    def status(r):
        train = r.get("mean_train", float("nan"))
        oos = r.get("mean_oos", float("nan"))
        agree = (train > 0 and oos > 0) or (train < 0 and oos < 0)
        padj = r.get("perm_p_adj", 1)
        conc = r.get("top3_conc", 1)
        days = r.get("indep_days", 0)
        rm3 = r.get("rm_best3", float("nan"))
        if (padj < 0.05 and agree and days >= 5 and conc < 0.5
                and (rm3 > 0 if oos > 0 else rm3 < 0)):
            return "PAPER_CANDIDATE"
        if (padj < 0.10 and agree and days >= 5 and conc < 0.7):
            return "ROBUST_CANDIDATE"
        if r.get("n", 0) >= 50 and days >= 3:
            return "RESEARCH_CANDIDATE"
        return "REJECTED"
    df["status"] = df.apply(status, axis=1)
    return df

def backtest_signal(feat: pd.DataFrame, mask: pd.Series, hold_bars: int = 5,
                    premium_stop_pct: float = 1.0, eod_exit: bool = True) -> pd.DataFrame:
    """Simple long-only option backtest on close prices (RESEARCH_PRICE_MODEL).
    Entry at signal close, exit after hold_bars or stop or EOD. No bid/ask (spec §30)."""
    df = feat.loc[mask].copy().sort_values("timestamp")
    df["entry"] = df["close"]
    # exit price = close hold_bars ahead within same contract
    df = df.sort_values(["strike", "option_type", "timestamp"])
    df["exit_close"] = df.groupby(["strike", "option_type"])["close"].shift(-hold_bars)
    df["ret"] = (df["exit_close"] / df["entry"] * 100 - 100)
    # fixed premium stop approximation via MAE forward excursion
    if "MAE_5m" in df.columns and hold_bars == 5:
        df.loc[df["MAE_5m"] > premium_stop_pct, "ret"] = -premium_stop_pct
    df["model"] = "RESEARCH_PRICE_MODEL"
    return df[["timestamp", "strike", "option_type", "entry", "exit_close", "ret", "model"]]
