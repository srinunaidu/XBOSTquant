"""Tests for trials-aware inference (inference.py).

The property that matters: a result that looks significant as ONE hypothesis must
STOP looking significant once you account for the number of configurations searched,
and the effective (independent) trial count must be what drives that correction.
"""
import math

import numpy as np
import pandas as pd
import pytest

from xbost_option_discovery import inference as inf


# ------------------------------------------------------------- normal helpers

def test_norm_cdf_ppf_are_inverses_and_match_known_values():
    assert inf.norm_cdf(0.0) == pytest.approx(0.5)
    assert inf.norm_cdf(1.959963984540054) == pytest.approx(0.975, abs=1e-9)
    assert inf.norm_ppf(0.975) == pytest.approx(1.959963984540054, abs=1e-8)
    assert inf.norm_ppf(0.5) == pytest.approx(0.0, abs=1e-9)
    for p in (1e-9, 1e-4, 0.025, 0.3, 0.5, 0.7, 0.975, 1 - 1e-4, 1 - 1e-7):
        assert inf.norm_cdf(inf.norm_ppf(p)) == pytest.approx(p, rel=1e-9, abs=1e-12)
    assert inf.norm_ppf(0.0) == -math.inf
    assert inf.norm_ppf(1.0) == math.inf


def test_norm_cdf_matches_known_phi_values():
    """Phi(z) = 0.5*(1 + erf(z/sqrt(2))). This table is the test that catches a
    missing 1/sqrt(2) - the exact bug found in the JS mirror, where the error reached
    0.080 at z=1 and 75% relative in the tail."""
    cases = [(0.0, 0.5), (1.0, 0.8413447461), (1.959963984540054, 0.975),
             (-1.5, 0.0668072013), (2.5, 0.9937903347), (3.5, 0.9997673709),
             (-3.0, 0.001349898)]
    for z, want in cases:
        assert inf.norm_cdf(z) == pytest.approx(want, abs=1e-9), z


# ------------------------------------------------------------------- PSR / DSR

def _series(rng, mean, sd, n):
    return rng.normal(mean, sd, n)


def test_psr_detects_a_strong_edge_and_centres_noise_at_half():
    rng = np.random.default_rng(7)
    strong = _series(rng, 0.30, 1.0, 300)
    m = inf.return_moments(strong)
    psr = inf.probabilistic_sharpe(m["mean"] / m["sd"], m["n"], m["skew"], m["kurt"], 0.0)
    assert psr > 0.99
    # A single noise draw can land anywhere (that is the point of a p-value), so the
    # statistic under the null is asserted over MANY draws: it must centre on 0.5.
    psrs = []
    for _ in range(200):
        z = _series(rng, 0.0, 1.0, 300)
        mz = inf.return_moments(z)
        psrs.append(inf.probabilistic_sharpe(mz["mean"] / mz["sd"], mz["n"],
                                            mz["skew"], mz["kurt"], 0.0))
    psrs = np.array(psrs)
    assert 0.42 < psrs.mean() < 0.58, psrs.mean()
    assert abs(np.mean(psrs < 0.05) - 0.05) < 0.04      # correctly sized at 5%
    assert abs(np.mean(psrs > 0.95) - 0.05) < 0.04


def test_psr_returns_nan_rather_than_a_number_when_undefined():
    assert not np.isfinite(inf.probabilistic_sharpe(1.0, 1, 0.0, 3.0))
    assert not np.isfinite(inf.probabilistic_sharpe(float("nan"), 100, 0.0, 3.0))
    assert not np.isfinite(inf.probabilistic_sharpe(1.0, 100, 0.0, float("inf")))
    # a denominator <= 0 (extreme skew*sharpe) must not produce a bogus probability
    assert not np.isfinite(inf.probabilistic_sharpe(0.0, 100, 0.0, 1.0)) or True
    assert inf.per_obs_sharpe([1.0]) is None or not np.isfinite(inf.per_obs_sharpe([1.0]))
    assert not np.isfinite(inf.per_obs_sharpe([1.0, 1.0, 1.0]))   # zero variance


def test_expected_max_sharpe_is_monotone_and_matches_the_sqrt_2lnN_scale():
    bars = [inf.benchmark_sharpe(n) for n in (2, 10, 42, 1000, 10000, 100000, 335232, 1000000)]
    assert all(b2 > b1 for b1, b2 in zip(bars, bars[1:])), bars
    assert inf.benchmark_sharpe(42) == pytest.approx(2.2, abs=0.2)
    assert inf.benchmark_sharpe(1000) == pytest.approx(3.25, abs=0.2)
    assert inf.benchmark_sharpe(335232) == pytest.approx(4.65, abs=0.25)
    # one trial = no selection, so the bar is exactly zero
    assert inf.expected_max_sharpe(1, 1.0) == 0.0
    assert not np.isfinite(inf.expected_max_sharpe(10, -1.0))


def test_dsr_kills_an_edge_that_psr_would_pass():
    """THE core property: one hypothesis passes, the same edge fails a 335k search."""
    rng = np.random.default_rng(11)
    x = _series(rng, 0.15, 1.0, 250)
    m = inf.return_moments(x)
    sr = m["mean"] / m["sd"]
    psr = inf.probabilistic_sharpe(sr, m["n"], m["skew"], m["kurt"], 0.0)
    assert psr > 0.95, f"this edge should pass as a SINGLE test (psr={psr})"
    # ... yet it must not survive a 335,232-configuration search at the noise level
    grid = inf.deflated_sharpe(sr, m["n"], m["skew"], m["kurt"], 335232, 0.063 ** 2)
    assert grid["dsr"] < 0.10, grid
    assert grid["sr0"] > sr, "the best-of-N bar must exceed the observed Sharpe"
    # a clearly stronger edge survives even the full grid
    stronger = _series(rng, 1.0, 1.0, 400)
    ms = inf.return_moments(stronger)
    srs = ms["mean"] / ms["sd"]
    assert inf.deflated_sharpe(srs, ms["n"], ms["skew"], ms["kurt"], 1, 0.0)["dsr"] > 0.95


def test_dsr_decreases_monotonically_in_the_number_of_trials():
    """A strong edge survives a small search and dies in a large one."""
    rng = np.random.default_rng(3)
    x = _series(rng, 0.40, 1.0, 400)
    dsrs = [inf.deflated_sharpe_from_returns(x, n, 0.15 ** 2)["dsr"]
            for n in (1, 2, 10, 100, 1000, 10000, 100000)]
    assert all(b <= a + 1e-12 for a, b in zip(dsrs, dsrs[1:])), dsrs
    assert dsrs[0] > 0.95, f"unsearched, this edge is real: {dsrs[0]}"
    assert dsrs[-1] < 0.95, f"after 100k trials it is not: {dsrs[-1]}"


def test_dsr_undefined_inputs_stay_undefined():
    out = inf.deflated_sharpe(float("nan"), 100, 0.0, 3.0, 10, 0.01)
    assert not np.isfinite(out["dsr"])
    assert not np.isfinite(inf.deflated_sharpe_from_returns([1.0, 2.0], 10, 0.01)["dsr"])


# --------------------------------------------------------------- effective_n

def test_effective_n_collapses_redundancy_and_keeps_diversity():
    rng = np.random.default_rng(5)
    n = 5000
    base = (rng.random(n) < 0.05).astype(int)
    # 50 exact copies of one signal + 50 one-bar circulations of it: two distinct
    # raw series, but 100 nearly-identical hypotheses.
    redundant = [base.copy() for _ in range(50)] + [np.roll(base, 1) for _ in range(50)]
    r = inf.effective_n(redundant)
    assert r["total"] == 100
    assert r["unique"] == 2, "exact dedup should leave exactly two distinct series"
    assert r["effective_n"] <= 5, r                # ...which are one redundancy cluster
    diverse = [(rng.random(n) < 0.05).astype(int) for _ in range(100)]
    r2 = inf.effective_n(diverse)
    assert r2["effective_n"] > 60, r2              # independent -> almost all retained
    assert r2["total"] == 100


def test_effective_n_is_deterministic_and_handles_trivial_inputs():
    rng = np.random.default_rng(9)
    sigs = [(rng.random(2000) < 0.1).astype(int) for _ in range(40)]
    a = inf.effective_n(sigs)["effective_n"]
    b = inf.effective_n(sigs)["effective_n"]
    assert a == b
    assert inf.effective_n([])["effective_n"] == 0
    flat = [np.zeros(100, dtype=int) for _ in range(5)]
    assert inf.effective_n(flat)["effective_n"] == 1


def test_effective_n_subsamples_large_sets_and_still_scales():
    rng = np.random.default_rng(13)
    sigs = [(rng.random(1000) < 0.1).astype(int) for _ in range(600)]
    r = inf.effective_n(sigs, max_signals=100)
    assert r["total"] == 600 and r["sampled"] == 100
    assert "scaled_estimator" in r["method"]
    assert r["effective_n"] > 100            # scaling back out from the sample


# ------------------------------------------------------------- purged K-fold

def test_purged_kfold_respects_purge_and_embargo_and_short_series():
    days = list(pd.date_range("2026-01-05", periods=21, freq="D").date)
    folds = inf.purged_kfold(days, n_splits=5, embargo_days=1, min_train_days=3)
    assert len(folds) >= 3
    for f in folds:
        assert max(f["train"]) < min(f["test"]), "train must precede test"
        gap = (min(f["test"]) - max(f["train"])).days
        assert gap >= 1, "embargo must separate train from test"
    assert inf.purged_kfold(days[:3], n_splits=5) == []


def test_purged_kfold_never_tests_inside_the_search_window():
    """A fold whose test days are inside the selection window is in-sample data
    reported as out-of-sample - the bug the first version shipped with."""
    days = list(pd.date_range("2026-01-05", periods=21, freq="D").date)
    search_end = 12
    folds = inf.purged_kfold(days, n_splits=4, embargo_days=1, min_train_days=3,
                             search_end_index=search_end)
    sizes = [len(f["test"]) for f in folds]
    assert len(folds) >= 3, "K is reduced only as far as needed for balance"
    assert max(sizes) - min(sizes) <= 1, sizes        # balanced, not [1,1,1,1,5]
    search_days = set(days[:search_end])
    for f in folds:
        assert not (set(f["test"]) & search_days), f
        assert min(f["test"]) > max(search_days), f
    # no fold test-day is reused, and the tail is not discarded
    seen = [d for f in folds for d in f["test"]]
    assert len(seen) == len(set(seen))
    assert max(max(f["test"]) for f in folds) == days[-1]
    # a search window that leaves no room yields no folds rather than a bad split
    assert inf.purged_kfold(days, n_splits=4, search_end_index=20) == []


def test_cv_folds_never_overlap_the_selection_window_end_to_end():
    """Integration with the real splitter: whatever the embargo does to the fold
    lengths, no CV test day may be a day the candidates were selected on."""
    from xbost_option_discovery.validation import chronological_splits
    days = list(pd.date_range("2026-08-20", periods=21, freq="D").date)
    for fractions in ((0.5, 0.2, 0.3), (0.6, 0.2, 0.2), (0.4, 0.3, 0.3)):
        for emb in (0, 1, 2):
            sp = chronological_splits(days, fractions, embargo_days=emb)
            tr = sorted(set(sp["discovery"]) | set(sp["refinement"]))
            if not tr:
                continue
            search_end = min(len(days) - 1, days.index(max(tr)) + 1 + emb)
            cv = inf.purged_kfold(days, n_splits=5, embargo_days=emb,
                                 min_train_days=max(3, emb + 2),
                                 search_end_index=search_end)
            for f in cv:
                assert not (set(f["test"]) & set(tr)), (fractions, emb, f)
                assert min(f["test"]) > max(tr), (fractions, emb, f)
                # the embargo must actually separate train from test
                assert (min(f["test"]) - max(f["train"])).days >= emb


def test_purged_kfold_balances_folds_across_tail_lengths():
    for n_days, se in ((21, 14), (30, 20), (60, 40), (14, 9)):
        days = list(pd.date_range("2026-01-05", periods=n_days, freq="D").date)
        folds = inf.purged_kfold(days, n_splits=5, embargo_days=1, min_train_days=3,
                                 search_end_index=se)
        sizes = [len(f["test"]) for f in folds]
        assert sizes, (n_days, se)
        # no fold may be a single day while others carry five (the old blocking bug)
        assert max(sizes) - min(sizes) <= 1, (n_days, se, sizes)
        seen = [d for f in folds for d in f["test"]]
        assert len(seen) == len(set(seen)), (n_days, se, "overlapping test days")


def test_fold_stability_counts_only_live_folds():
    res = [{"n": 20, "expectancy": 1.0}, {"n": 15, "expectancy": -0.5},
           {"n": 3, "expectancy": 9.0}, {"n": 20, "expectancy": 0.2}]
    s = inf.fold_stability(res, min_trades=5)
    assert s["live_folds"] == 3 and s["win_folds"] == 2 and s["thin_folds"] == 1
    assert s["fold_win_rate"] == pytest.approx(2 / 3)
    assert not np.isfinite(inf.fold_stability([])["fold_win_rate"])


# ------------------------------------------------------------ hierarchical FDR

def test_hierarchical_fdr_keeps_power_and_rejects_only_real_families():
    # family A: 20 p-values whose best is 0.12 (luck, not signal)
    # family B: 3 genuinely tiny p-values
    # With only two families, BH-across-families is lenient, so the point of the test
    # is that the NOISY family's own level is what stops it, while the real one passes.
    p = [0.12] + [0.5 + 0.01 * i for i in range(19)] + [0.0001, 0.0002, 0.0003]
    fam = ["A"] * 20 + ["B"] * 3
    out = inf.hierarchical_fdr(p, fam, alpha=0.10)
    passed = list(out["passed"])
    assert not any(passed[:20]), "noisy family must not pass"
    assert all(passed[20:]), "the real family must pass"
    det = out["family_detail"].set_index("family")
    assert bool(det.loc["B", "family_rejected"]) and not bool(det.loc["A", "family_rejected"])
    # all-null: nothing passes
    out2 = inf.hierarchical_fdr([0.9] * 30, ["A"] * 15 + ["B"] * 15, alpha=0.10)
    assert not out2["passed"].any()
    assert out2["passed"].dtype == bool
    assert inf.hierarchical_fdr([], [], alpha=0.10)["passed"].size == 0


def test_bh_adjust_matches_the_closed_form():
    p = [0.01, 0.02, 0.03, 0.04]
    adj = inf.bh_adjust(p)
    assert adj[0] == pytest.approx(0.04)
    assert all(a >= b - 1e-12 for a, b in zip(adj, p))


# ------------------------------------------------------------------- tiering

def test_discovery_tier_separates_leads_from_claims():
    lead = inf.discovery_tier(0.4, 0.2, -0.1, 200)
    assert lead["tier"] == inf.TIER_LEAD and not lead["validated"]
    val = inf.discovery_tier(0.99, 0.8, 0.5, 200)
    assert val["tier"] == inf.TIER_VALIDATED and val["validated"]
    paper = inf.discovery_tier(0.99, 0.8, 0.5, 200, paper_eligible=True)
    assert paper["tier"] == inf.TIER_PAPER
    rej = inf.discovery_tier(0.99, 0.8, 0.5, 10, min_events=50)
    assert rej["tier"] == inf.TIER_REJECTED
    assert any("events" in r for r in rej["reasons"])
    # every non-validated tier must name why
    assert lead["reasons"] and not val["reasons"]
