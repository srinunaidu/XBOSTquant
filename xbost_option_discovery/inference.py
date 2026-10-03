"""Trials-aware statistical inference (P0/P1 discovery-yield layer).

Why this module exists
---------------------
Both search engines were making claims without accounting for HOW MUCH they
searched, and they failed in opposite directions:

* the option engine tested ~42 candidates and applied Benjamini-Hochberg to a
  permutation p-value, so nothing survived;
* the indicator engine tests ~335,232 configurations and applied NOTHING. Its
  `sharpeAdj` is documented in-source as "Empirical-Bayes-style shrinkage toward 0
  (NOT a statistical estimator)".

Under the null the expected BEST Sharpe of N independent trials is approximately
sqrt(2 ln N) standard errors:

    42 -> 2.03 sigma      1,000 -> 3.12      100,000 -> 4.28
    335,232 -> 4.54       1,000,000 -> 4.77

So the indicator engine's winner must clear ~4.5 sigma merely to be distinguishable
from the luckiest of 335k coin flips. The correct instrument for "I searched N
configurations and this is the best" is the Deflated Sharpe Ratio (Bailey &
Lopez de Prado, 2014), which uses N, the dispersion of the trial Sharpes, and the
skew/kurtosis of the returns. This module implements it, plus the pieces that raise
discovery YIELD legitimately rather than by loosening gates:

  PSR / DSR              - trials-aware significance per candidate
  expected_max_sharpe    - the best-of-N null bar, for honest reporting
  effective_n            - how many INDEPENDENT hypotheses were really tested
  purged_kfold           - K purged/embargoed OOS folds instead of one split
  hierarchical_fdr       - family-wise FDR that keeps power across many families

Everything is pure and dependency-free (no scipy).
"""
import hashlib
import math

import numpy as np
import pandas as pd

NA = float("nan")
EULER_GAMMA = 0.5772156649015329

# ---------------------------------------------------------------- normal helpers

_A = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
_B = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01)
_C = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
_D = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
      3.754408661907416e+00)
_P_LOW, _P_HIGH = 0.02425, 1.0 - 0.02425


def norm_cdf(x):
    """Standard normal CDF via erf."""
    if not np.isfinite(x):
        return NA
    return 0.5 * (1.0 + math.erf(float(x) / math.sqrt(2.0)))


def norm_ppf(p):
    """Inverse standard normal CDF (Acklam + one Halley refinement).

    The refinement matters here: `expected_max_sharpe` calls this at
    `1 - 1/n_trials`, i.e. p ~ 1 - 3e-6 for a 335k-configuration search, so the
    extreme tail must be accurate rather than merely close.
    """
    p = float(p)
    if not np.isfinite(p) or p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf
    if p < _P_LOW:
        q = math.sqrt(-2.0 * math.log(p))
        x = (((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / \
            ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1.0)
    elif p <= _P_HIGH:
        q = p - 0.5
        r = q * q
        x = (((((_A[0] * r + _A[1]) * r + _A[2]) * r + _A[3]) * r + _A[4]) * r + _A[5]) * q / \
            (((((_B[0] * r + _B[1]) * r + _B[2]) * r + _B[3]) * r + _B[4]) * r + 1.0)
    else:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        x = -(((((_C[0] * q + _C[1]) * q + _C[2]) * q + _C[3]) * q + _C[4]) * q + _C[5]) / \
            ((((_D[0] * q + _D[1]) * q + _D[2]) * q + _D[3]) * q + 1.0)
    # Halley refinement against the accurate CDF
    e = norm_cdf(x) - p
    u = e * math.sqrt(2.0 * math.pi) * math.exp(x * x / 2.0)
    x = x - u / (1.0 + x * u / 2.0)
    return x


# ------------------------------------------------------------ Sharpe statistics

def per_obs_sharpe(returns):
    """NON-ANNUALISED per-observation Sharpe: mean/std with SAMPLE std (ddof=1).

    The PSR/DSR formulas are written for this quantity, never for an annualised
    Sharpe. Returns NaN when undefined.
    """
    r = pd.Series(list(returns) if not isinstance(returns, pd.Series) else returns,
                  dtype="float64").dropna().to_numpy()
    if len(r) < 2:
        return NA
    sd = r.std(ddof=1)
    if not np.isfinite(sd) or sd <= 0:
        return NA
    return float(r.mean() / sd)


def return_moments(returns):
    """(n, mean, sd, skew, raw kurtosis) of a return series. Kurtosis is RAW
    (normal = 3), because the PSR denominator uses (kurt - 1)/4."""
    r = pd.Series(list(returns) if not isinstance(returns, pd.Series) else returns,
                  dtype="float64").dropna().to_numpy()
    n = len(r)
    if n < 4:
        return {"n": n, "mean": NA, "sd": NA, "skew": NA, "kurt": NA}
    m = r.mean()
    sd = r.std(ddof=1)
    if not np.isfinite(sd) or sd <= 0:
        return {"n": n, "mean": float(m), "sd": NA, "skew": NA, "kurt": NA}
    z = (r - m) / sd
    return {"n": n, "mean": float(m), "sd": float(sd),
            "skew": float(np.mean(z ** 3)), "kurt": float(np.mean(z ** 4))}


def probabilistic_sharpe(sr, n_obs, skew=0.0, kurt=3.0, sr_benchmark=0.0):
    """PSR: P(true per-observation Sharpe > sr_benchmark).

    PSR = Phi( (sr - sr*) * sqrt(T-1) / sqrt(1 - skew*sr + ((kurt-1)/4)*sr^2) )

    `sr` and `sr_benchmark` are NON-ANNUALISED; `kurt` is RAW kurtosis (normal = 3).
    """
    try:
        sr = float(sr); n_obs = float(n_obs); skew = float(skew); kurt = float(kurt)
        sr_benchmark = float(sr_benchmark)
    except (TypeError, ValueError):
        return NA
    if not (np.isfinite(sr) and np.isfinite(n_obs) and np.isfinite(skew)
            and np.isfinite(kurt) and np.isfinite(sr_benchmark)):
        return NA
    if n_obs < 2:
        return NA
    denom = 1.0 - skew * sr + ((kurt - 1.0) / 4.0) * sr * sr
    if not np.isfinite(denom) or denom <= 0:
        return NA
    return norm_cdf((sr - sr_benchmark) * math.sqrt(n_obs - 1.0) / math.sqrt(denom))


def expected_max_sharpe(n_trials, sr_variance=1.0):
    """Expected maximum Sharpe under the null across `n_trials` trials.

    SR0 = sqrt(V[SR]) * ( (1-g)*Phi^-1(1 - 1/N) + g*Phi^-1(1 - 1/(N*e)) ),  g = Euler-Mascheroni

    With sr_variance=1 this is the "bar in sigma" reported by benchmark_sharpe().
    With a single trial there is NO selection, so the bar is exactly 0 (this is the
    correct limit; returning NaN would make the "one unsearched hypothesis" case
    unrepresentable).
    """
    try:
        n = float(n_trials); v = float(sr_variance)
    except (TypeError, ValueError):
        return NA
    if not (np.isfinite(n) and np.isfinite(v)) or v < 0:
        return NA
    if n < 2:
        return 0.0
    return math.sqrt(v) * ((1.0 - EULER_GAMMA) * norm_ppf(1.0 - 1.0 / n)
                           + EULER_GAMMA * norm_ppf(1.0 - 1.0 / (n * math.e)))


def benchmark_sharpe(n_trials):
    """The best-of-N null bar in sigma units (sr_variance = 1)."""
    return expected_max_sharpe(n_trials, 1.0)


def deflated_sharpe(sr, n_obs, skew, kurt, n_trials, sr_variance):
    """DSR = PSR evaluated against the best-of-N null bar.

    Returns the probability that the TRUE Sharpe exceeds zero given that
    `n_trials` configurations were searched and the trial Sharpes had variance
    `sr_variance`. This is the principled gate for a grid search: it is the only
    statistic here that uses the SIZE of the search.
    """
    sr0 = expected_max_sharpe(n_trials, sr_variance)
    out = {"dsr": NA, "sr0": sr0, "sr": sr, "n_obs": n_obs, "n_trials": n_trials,
           "sr_variance": sr_variance}
    if not np.isfinite(sr0):
        return out
    out["dsr"] = probabilistic_sharpe(sr, n_obs, skew, kurt, sr0)
    return out


def deflated_sharpe_from_returns(returns, n_trials, sr_variance):
    """Convenience: compute sr/T/skew/kurt from the series, then DSR."""
    m = return_moments(returns)
    if not np.isfinite(m["sd"]):
        return {"dsr": NA, "sr0": NA, "sr": NA, "n_obs": m["n"], "n_trials": n_trials,
                "sr_variance": sr_variance}
    return deflated_sharpe(m["mean"] / m["sd"], m["n"], m["skew"], m["kurt"],
                           n_trials, sr_variance)


# --------------------------------------------------- effective number of trials

def _bucket_density(sig, n_buckets):
    """Density of a signal over `n_buckets` equal buckets of the observation axis.

    Used as a cheap, locality-preserving signature: two signals that fire on the
    same bars have near-identical bucket densities, so redundancy can be measured
    on a 1024-length vector instead of the full 47k-bar mask.
    """
    s = np.asarray(sig, dtype=float)
    n = len(s)
    if n == 0:
        return np.zeros(n_buckets)
    idx = np.minimum((np.arange(n) * n_buckets) // max(1, n), n_buckets - 1)
    out = np.zeros(n_buckets)
    np.add.at(out, idx, np.nan_to_num(s, nan=0.0))
    cnt = np.bincount(idx, minlength=n_buckets).astype(float)
    cnt[cnt == 0] = 1.0
    return out / cnt


def effective_n(signals, corr_threshold=0.99, n_buckets=1024, max_signals=3000,
                seed=42, metric="auto"):
    """Estimate how many INDEPENDENT hypotheses a candidate set really contains.

    Correcting for 335,232 grid cells when they collapse onto a few hundred distinct
    signals is the difference between "nothing survives" and "some survive" -- and it
    is legitimate, because the correction is applied to the number of distinct
    hypotheses rather than to raw grid size.

    Steps: exact dedup by mask hash -> bucket-density signature -> greedy clustering
    on |correlation| >= `corr_threshold`. When the candidate count exceeds
    `max_signals` a deterministic subsample is clustered and the result is SCALED,
    so the return value is an ESTIMATOR (`method` records which).
    """
    sigs = [np.asarray(s) for s in signals]
    n_total = len(sigs)
    if n_total == 0:
        return {"effective_n": 0, "total": 0, "sampled": 0, "clusters": 0,
                "exact_duplicates": 0, "corr_threshold": corr_threshold,
                "method": "empty"}
    hashes, uniq, exact_dups = [], [], 0
    for s in sigs:
        h = hashlib.sha1(np.ascontiguousarray(s.astype(np.int8)).tobytes()).hexdigest()
        hashes.append(h)
    seen = set()
    for s, h in zip(sigs, hashes):
        if h in seen:
            exact_dups += 1
            continue
        seen.add(h)
        uniq.append(s)
    n_uniq = len(uniq)
    rng = np.random.default_rng(seed)
    if n_uniq > max_signals:
        sel = np.sort(rng.choice(n_uniq, size=max_signals, replace=False))
        sample = [uniq[i] for i in sel]
        method = f"scaled_estimator(bucket={n_buckets},sampled={max_signals}/{n_uniq})"
    else:
        sample = uniq
        method = f"exact(bucket={n_buckets})"
    dens = np.vstack([_bucket_density(s, n_buckets) for s in sample])
    # deterministic order: densest (most events) first, then by content hash
    mags = np.abs(dens).sum(axis=1)
    order = np.lexsort((np.array([hashlib.sha1(d.tobytes()).hexdigest() for d in dens]), -mags))
    dens = dens[order]
    reps = []          # list of (dens_vector, magnitude)
    assign = np.full(len(sample), -1, dtype=int)
    for i in range(len(dens)):
        d = dens[i]
        placed = False
        for ci, (rd, rm) in enumerate(reps):
            # NOTE: no magnitude prefilter — correlation is scale-invariant,
            # so magnitude ratio cannot gate |corr| (a previous shortcut did
            # this incorrectly and over-split clusters).
            a = d - d.mean(); b = rd - rd.mean()
            na = np.linalg.norm(a); nb = np.linalg.norm(b)
            if na == 0 or nb == 0:
                c = 1.0 if np.array_equal(d, rd) else 0.0
            else:
                c = float(np.dot(a, b) / (na * nb))
            if abs(c) >= corr_threshold:
                assign[i] = ci
                placed = True
                break
        if not placed:
            reps.append((d, mags[order][i]))
            assign[i] = len(reps) - 1
    clusters = len(reps)
    eff = clusters if n_uniq <= max_signals else int(round(n_total * clusters / max(1, len(sample))))
    return {"effective_n": int(max(1, eff)), "total": n_total, "unique": n_uniq,
            "sampled": len(sample), "clusters": clusters,
            "exact_duplicates": exact_dups, "corr_threshold": corr_threshold,
            "method": method, "metric": metric}


# ------------------------------------------------------ purged K-fold validation

def purged_kfold(days, n_splits=5, embargo_days=1, min_train_days=3,
                 search_end_index=None, min_test_days=2):
    """Expanding-window purged/embargoed K-fold over trading DAYS.

    One 3-way split yields a SINGLE out-of-sample window, which on a 21-day dataset
    has almost no power. K purged folds yield K independent OOS measurements from
    the same data. The trailing `embargo_days` of each training block are dropped so
    a label cannot reach into the test block.

    `search_end_index` is the number of leading days consumed by candidate SELECTION.
    When given, folds are built only from the days AFTER it, because a fold whose
    test days sit inside the search window is not out-of-sample at all - it is
    in-sample data being reported as OOS. (That bug was present in the first version
    of this function: fold 1 tested on days 3-5 while days 0-11 were the search
    window.)

    Folds are balanced with at least `min_test_days` days each: K is reduced rather
    than emitting 1-day folds, which carry almost no trades and would make the
    fold-win rate meaningless noise.

    Returns a list of {fold, train, test}. Fewer folds are returned (never a bad
    split) when the series is too short.
    """
    days = sorted(days)
    n = len(days)
    if n < max(4, min_train_days + 2):
        return []
    start = 0
    if search_end_index is not None:
        start = max(0, min(int(search_end_index), n - 1))
    tail = n - start
    mtd = max(1, int(min_test_days))
    if tail < mtd + 1:
        return []
    n_splits = max(1, min(int(n_splits), tail // mtd))
    # even boundaries (not a fixed block with the remainder dumped on the last fold,
    # which produced sizes like [1,1,1,1,5] and made the fold-win rate noise)
    offs = [int(round(k * tail / n_splits)) for k in range(n_splits + 1)]
    folds = []
    for k in range(n_splits):
        a, b = start + offs[k], start + offs[k + 1]
        if b <= a:
            continue
        train = days[:max(0, a - max(0, int(embargo_days)))]
        test = days[a:b]
        if len(train) >= min_train_days and len(test) >= 1:
            folds.append({"fold": len(folds) + 1, "train": train, "test": test})
    return folds


def fold_stability(fold_results, min_trades=5):
    """Summarise per-fold OOS results: how many folds were positive.

    `fold_results`: list of dicts with 'n' (trades) and 'expectancy'.
    """
    live = [f for f in fold_results if f.get("n", 0) >= min_trades
            and np.isfinite(f.get("expectancy", NA))]
    wins = [f for f in live if f["expectancy"] > 0]
    return {"folds": len(fold_results), "live_folds": len(live), "win_folds": len(wins),
            "fold_win_rate": (len(wins) / len(live)) if live else NA,
            "thin_folds": len(fold_results) - len(live),
            "per_fold": fold_results}


# ------------------------------------------------------------------- hierarchical FDR

def bh_adjust(pvals):
    """Benjamini-Hochberg adjusted p-values (NaN-free input expected)."""
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    if n == 0:
        return p
    order = np.argsort(p)
    adj = np.empty(n)
    prev = 1.0
    for i in reversed(range(n)):
        v = min(prev, p[order[i]] * n / (i + 1))
        adj[order[i]] = v
        prev = v
    return adj


def hierarchical_fdr(pvals, families, alpha=0.10):
    """Yekutieli hierarchical FDR: BH within each family, then BH across families.

    The family p-value is the minimum member p-value. A family is only kept if it is
    rejected at the family level, which preserves power when there are many families
    (here: many indicator/event families) instead of paying one global Bonferroni-like
    penalty for the whole search.
    """
    p = np.asarray([1.0 if (v != v) else float(v) for v in pvals], dtype=float)
    fam = np.asarray(families)
    if len(p) == 0:
        return {"passed": np.array([], dtype=bool), "family_p": pd.DataFrame(), "alpha": alpha}
    uniq = list(pd.unique(fam))
    fam_min, fam_rows = [], {}
    for f in uniq:
        m = fam == f
        fam_rows[f] = m
        fam_min.append(p[m].min() if m.any() else 1.0)
    fam_adj = bh_adjust(fam_min)
    fam_ok = {f: bool(a < alpha) for f, a in zip(uniq, fam_adj)}
    within = bh_adjust(p)
    passed = np.array([bool(fam_ok.get(fam[i], False) and within[i] < alpha)
                       for i in range(len(p))], dtype=bool)
    detail = pd.DataFrame([{"family": f, "n": int(fam_rows[f].sum()),
                            "min_p": float(mn), "family_p_adj": float(a),
                            "family_rejected": bool(a < alpha)}
                           for f, mn, a in zip(uniq, fam_min, fam_adj)])
    return {"passed": passed, "within_p_adj": within, "family_detail": detail,
            "alpha": alpha, "n_families": len(uniq),
            "families_rejected": int(sum(fam_ok.values()))}


# ------------------------------------------------------------------ tiering

TIER_LEAD = "LEAD"
TIER_VALIDATED = "VALIDATED"
TIER_PAPER = "PAPER"
TIER_REJECTED = "REJECTED"


def discovery_tier(dsr, fold_win_rate, oos_expectancy, n_events, min_events=50,
                   dsr_threshold=0.95, min_fold_win_rate=0.6, paper_eligible=False,
                   min_folds=3):
    """LEAD -> VALIDATED -> PAPER classification for the tiered output.

    The point is to give the operator MANY leads (ranked, exploratory, clearly not
    claims) while keeping VALIDATED small and trials-aware, so raising the search
    breadth raises the lead count without inflating the claim count.
    """
    reasons = []
    if n_events < min_events:
        reasons.append(f"events {n_events} < {min_events}")
    if not (np.isfinite(dsr) and dsr >= dsr_threshold):
        reasons.append(f"dsr {dsr if np.isfinite(dsr) else 'NA'} < {dsr_threshold}")
    if not (np.isfinite(fold_win_rate) and fold_win_rate >= min_fold_win_rate):
        reasons.append(f"fold_win_rate {fold_win_rate if np.isfinite(fold_win_rate) else 'NA'}"
                       f" < {min_fold_win_rate}")
    if not (np.isfinite(oos_expectancy) and oos_expectancy > 0):
        reasons.append(f"oos_expectancy {oos_expectancy if np.isfinite(oos_expectancy) else 'NA'} <= 0")
    validated = not reasons
    if validated and paper_eligible:
        tier = TIER_PAPER
    elif validated:
        tier = TIER_VALIDATED
    elif n_events >= min_events:
        tier = TIER_LEAD
    else:
        tier = TIER_REJECTED
    return {"tier": tier, "validated": validated, "reasons": reasons}
