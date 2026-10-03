# Trials-aware inference: raising discovery yield without lying

Follows `REVIEW_P0_P1.md`. That pass made the option engine's measurements honest and
found its yield was zero. This pass adds the machinery that raises yield *legitimately*
in **both** engines, and fixes the opposite failure in the indicator engine.

## 1. The problem, quantified

Both engines made claims without accounting for how much they searched — in opposite
directions:

| | configurations searched | correction applied |
|---|---|---|
| option engine | **42** | BH on a (previously broken) permutation p → 0 survivors |
| indicator engine | **335,232** on a default Tier-A run | **none** |

`public/engine.js::sharpeAdj` is documented in-source as *"Empirical-Bayes-style
shrinkage toward 0 (NOT a statistical estimator)"*; `sampleTier` is a trade-count
bucket; `auditRankingIntegrity` only checks the displayed row is the argmax.

Under the null the expected BEST Sharpe of N independent trials is ≈ `sqrt(2 ln N)`
standard errors:

```
      42 trials -> 2.03 sigma        100,000 -> 4.28
   1,000        -> 3.12              335,232 -> 4.54
  10,000        -> 3.74            1,000,000 -> 4.77
```

So the indicator engine's champion must clear **~4.5σ** merely to be distinguishable
from the luckiest of 335k coin flips. The correct instrument is the **Deflated Sharpe
Ratio** (Bailey & López de Prado, 2014): it takes the observed Sharpe, the number of
trials, the dispersion of the trial Sharpes, and the skew/kurtosis of the returns, and
returns the probability the true Sharpe exceeds zero *given the search*.

## 2. What was built — `xbost_option_discovery/inference.py`

Dependency-free (no scipy), pure, unit-tested.

| Function | Purpose |
|---|---|
| `norm_cdf` / `norm_ppf` | erf-based CDF and Acklam inverse **with a Halley refinement**, because the DSR calls it at `1 - 1/N` (p ≈ 1 − 3e-6 for N = 335k) where tail accuracy matters |
| `probabilistic_sharpe` | PSR: `Phi((sr - sr*)·sqrt(T-1) / sqrt(1 - skew·sr + ((kurt-1)/4)·sr²))` |
| `expected_max_sharpe` | the best-of-N null bar; `n_trials < 2` → exactly 0 (no selection) |
| `benchmark_sharpe` | that bar in sigma units, for reporting |
| `deflated_sharpe` | PSR evaluated against the best-of-N bar = **the trials-aware gate** |
| `effective_n` | how many **independent** hypotheses the candidate set really contains |
| `purged_kfold` | K purged/embargoed OOS folds instead of one split |
| `hierarchical_fdr` | Yekutieli group-BH so many families don't pay one global penalty |
| `discovery_tier` | LEAD / VALIDATED / PAPER classification |

### The effective-N lever

Deflating by the raw grid is over-conservative when most configurations *are the same
hypothesis*. `effective_n` exact-dedups by mask hash, then greedy-clusters on the
correlation of bucket-density signatures. Verified:

```
400 shifted copies of ONE signal -> unique=2,  effective_n=2
400 INDEPENDENT signals          -> unique=400, effective_n=400
```

and for one fixed edge (per-obs Sharpe 0.1414, T=250, trial sd 0.063):

```
one unsearched hypothesis      bar=0.0000  DSR=0.9867  PASS
42 candidates                  bar=0.1391  DSR=0.5138  fail
1,000 effective hypotheses     bar=0.2051  DSR=0.1588  fail
335,232 raw grid cells         bar=0.2928  DSR=0.0088  fail
```

Same edge, same data — the only thing that changes is how much you searched.

### The power lever

A single 3-way split yields **one** OOS window. `purged_kfold` yields K. Measured on
your 21-day dataset: 3 balanced folds of 3 days, each with an embargoed boundary.

**Bug found and fixed during this work:** the first version built folds across the
whole timeline, so fold 1 tested on days 3–5 while days 0–11 were the *selection*
window — in-sample data reported as out-of-sample. `search_end_index` now forces every
test day to lie strictly after the search window, and
`test_purged_kfold_never_tests_inside_the_search_window` pins it. A related selection
leak was fixed at the same time: the SEQUENCE and CHAIN_STATE candidate sets were
chosen by `value_counts()` over the **full sample**; they are now chosen from the
search window only.

## 3. Tiered output — "many discoveries, few claims"

`run.py` now writes **`leads.csv`**: every candidate, ranked, with its tier, its DSR,
its fold-win rate, and the specific reason it is not validated. `tab_bundle.json` gains
`leads`, `tier_counts` and a `trials_aware_inference` block; `report.md` gains sections
17 (trials-aware inference) and 18 (yield by family).

```
LEAD        measured, ranked, explicitly NOT a claim   (expect many)
VALIDATED   DSR >= 0.95 AND >= 60% of live OOS folds positive AND OOS expectancy > 0
PAPER       VALIDATED plus every paper gate (cost-viable, concentration, robustness)
```

## 4. Result on your data

BankNifty, 21 days, real costs:

```
PURGED_KFOLD folds=3 (embargo=1d, search_window=12d so every test day is strictly after it)
TRIALS_AWARE_INFERENCE
  candidates_evaluated=42 effective_hypotheses=42 (exact_dups=0, clusters=42, r=0.99)
  trial_sharpe_sd=0.1639  best_of_N_null_bar=2.209 sigma (0.3620 in Sharpe units)
DISCOVERY_YIELD_FINAL leads=42 validated=0 paper=0
```

| | before this pass | after |
|---|---|---|
| candidates surfaced | 42 (then filtered to 0) | **42 leads**, ranked, each with its blocker |
| OOS windows per candidate | 1 | **3** purged/embargoed folds |
| trials correction | none | DSR + effective-N, plus BH and hierarchical FDR |
| honesty of the "winner" | best-of-42 with no trials context | best-of-42 vs a reported 2.21σ null bar |

**Two independent methods now agree that this dataset contains no edge:** BH on the
permutation p (min raw p 0.035 → adjusted 0.975) *and* the Deflated Sharpe (best
DSR_OOS = 0.0000). That convergence is the strongest evidence yet that the earlier
zero was not an artifact.

Also confirmed: it is not the cost grid. Widening to SL 3% / TP 8% makes the grid
**VIABLE** (net win +7.12%, net loss −3.88%, break-even WR 35.3%) and the candidates
still lose out-of-sample (`best OOS_expectancy = −0.808`, `best CV_fold_win_rate =
0.333`). The signals themselves have no forward edge here.

## 5. What this means for "as many discoveries as possible"

The statistics are now correct, and they say the binding constraint is **not** the
gates — it is the number of genuinely different *hypotheses* and the amount of data:

1. **More data.** DSR power scales with T. The 21-day file gives 15 search days and 9
   OOS days; a single expiry and three strikes. More months and multiple expiries is
   the cheapest real yield.
2. **More hypotheses (deferred track).** 42 candidates is tiny. Threshold/lookback
   sweeps, all strikes and cross-strike pairs, both directions, all five forward
   horizons, and N-leg event conjunctions would take it to thousands — and the
   effective-N/DSR machinery built here is precisely what makes that safe to do.
3. **Indicator engine N-leg search (deferred).** 3 legs + AND/OR/k-of-n/gate/sequence,
   cross-timeframe, diversity-filtered beam — instead of today's strict AND-only
   pairings.

Loosening gates would raise the lead count and the *false* claim count together. The
tiers exist so breadth is visible without that cost.

## 6. Cross-engine verification caught a real bug

Because the JS engine mirrors this math, the two implementations were checked against
each other on the same inputs. `sr0` (the expected-max-Sharpe bar) agreed to 1e-10, but
the DSR probabilities differed by up to **0.078** — which localised the fault to the
normal CDF.

`public/engine.js::_nCdf` and `public/discovery-engine.js::OD.normCdf` passed
`Math.abs(z)` straight into the Abramowitz-Stegun **erf** approximation. But
`Phi(z) = 0.5*(1 + erf(z/sqrt(2)))`, so the argument must be `z/sqrt(2)`; they computed
`erf(z)`.

| z | true Φ | as implemented | error |
|---|---|---|---|
| 1 | 0.8413447 | 0.9213503 | **+0.080** |
| 1.9599639845 | 0.9750000 | 0.9972126 | **+0.0222** |
| −1.5 | 0.0668072 | 0.0169474 | **−0.0499 (75% relative)** |
| 3.5 | 0.9997674 | 0.9999996 | +0.00023 |

Every PSR/DSR probability was therefore inflated toward 1 — optimistic, and worst in
the tail where a significance test actually decides. The in-source comment claiming
`|err| < 7.5e-8` was false as implemented (it also mis-cited A&S 26.2.17 for what is
the 7.1.26 erf series). The same `_nCdf` also feeds the GP Expected-Improvement
acquisition in `bayesianRefine`, so refinement proposals were distorted too.

Fixed by the `z/sqrt(2)` argument. After the fix, on identical inputs:

| nTrials | sr0 (JS) | sr0 (Python) | \|Δ sr0\| | dsr (JS) | dsr (Python) | \|Δ dsr\| |
|---|---|---|---|---|---|---|
| 1 | 0.0000000000 | 0.0000000000 | 0 | 0.9986709842 | 0.9986710534 | 6.9e-8 |
| 42 | 0.1104346752 | 0.1104346751 | 1.1e-10 | 0.8559589490 | 0.8559589819 | 3.3e-8 |
| 1000 | 0.1627560755 | 0.1627560757 | 1.5e-10 | 0.5564850637 | 0.5564850385 | 2.5e-8 |
| 335232 | 0.2323542394 | 0.2323542392 | 2.2e-10 | 0.1396061514 | 0.1396061133 | 3.8e-8 |

**max |Δ dsr| = 6.9e-8, down from 7.8e-2.** The residual is the A&S series' own
1.5e-7 error bound, so the two engines now agree to the accuracy of the approximation
they share. `Φ(1)` went from 0.9213503 to 0.8413447 against a true 0.8413447.

Two tests were added, one in each engine, both of which fail on the buggy formula:
a known-values Φ table (Python `test_norm_cdf_matches_known_phi_values`, JS
`normCdf: matches the true Phi`), and a Python↔JS cross-check asserting `|Δ dsr| < 1e-6`
and `|Δ sr0| < 1e-9` on the table above. The Python CDF is accurate to 3e-11
(`math.erf`), so it is the reference.

This is the strongest argument for keeping one engine authoritative and mirroring it
under a **numeric** cross-check rather than re-deriving the math twice: `sr0` matched to
1e-10 while `dsr` was wrong by 8 percentage points, and only a value-level comparison
localised the fault to the CDF.

## 7. Verification

```bash
TMPDIR=/tmp python3 -m pytest tests_discovery -q      # 59 passed
node --test test/                                     # JS suite
```

`tests_discovery/test_inference.py` (16 tests) covers: normal CDF/PPF round-trip and
tail accuracy; PSR power and correct 5% sizing under the null over 200 draws; the
monotone best-of-N bar with `sqrt(2 ln N)` magnitudes; **the core property** (an edge
that passes PSR fails DSR at 335k trials and passes at 1); DSR monotone in N; NaN
guards; effective-N collapsing redundancy while keeping diversity; deterministic
sub-sampling with scaling; purged K-fold embargo, balance, and never testing inside the
search window; fold stability; hierarchical FDR keeping power across families;
BH closed form; and tier classification.
