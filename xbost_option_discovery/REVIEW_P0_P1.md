# Option discovery: P0/P1 review and fixes

Scope: the Python engine (`xbost_option_discovery/`), which is now the source of
truth. The JS web engine (`public/discovery-engine.js`) mirrors the critical fixes so
the GUI stops reporting false results. The equity/indicator terminal
(`public/engine.js` + `web/src/lib/runner.ts`) is untouched apart from its fill bug.

Everything below was reproduced by execution before being fixed.

---

## 1. Why you could never reach paper trade

Three independent locks, in causal order.

### 1.1 The surrogate test was invalid (root cause)  — `metrics.py`

```python
surr = np.array([... for p in (rng.permutation(r) for _ in range(n_perm))])
```

`rng.permutation(r)` permutes **the return vector**. Mean and standard deviation are
permutation-invariant, so every surrogate statistic equalled the observed statistic.
The p-value was therefore floating-point noise:

```
true mean=0.473 std=1.014 n=500   (a genuinely profitable strategy)
surrogate_mean = 10.43712463   observed SHARPE = 10.43712463
p across 200 genuinely profitable strategies: mean=0.845, share<0.10 = 2.0%
```

It rejected **98% of real edges at random**. `reporting.py` then did
`if padj >= 0.10: return "SURROGATE_REJECTED"` and `filters.py` F11 rejected the same
rows, so `ROBUST` / `OOS_SURVIVED` were unreachable. Your committed run
`runs/20261002-103512-854fae` confirms it: `perm_p_adj` min = **1.000**, 0 survivors.

**Fix.** `metrics.permutation_null(mask, labels, blocks)` rolls the **event mask** in
time within each `(symbol, day)` block, leaving the label series untouched. That
preserves the event count, the label autocorrelation and the intraday timing
distribution, and answers exactly one question: does *this* timing of events beat a
random timing of the same number of events? `surrogate_stats` is retained but returns
`deprecated: True` and NaN so it cannot be used by accident.

Verified: planted edge → `p = 0.005`; pure noise → `p = 0.50`.

### 1.2 Everything downstream keyed on that number

`reporting.py::assign_status`, `filters.py` F11/F13. With 1.1 fixed these become live.

### 1.3 The paper gate was hardcoded shut

* `reporting.py::paper_gate` had **3 `NO` branches and 0 `YES` branches**.
* `run.py` wrote `PAPER_ELIGIBLE: "FALSE"` literally and printed `PAPER_STATUS = BLOCKED`.
* `public/discovery-engine.js` did `c.paper_eligible = false` and `PAPER_ELIGIBLE: 'FALSE'`.
* `test/discovery.test.js` **asserted** it stayed false.

**Fix.** `paper.py::evaluate(row, settings, cost_model, ...)` derives eligibility from
measured evidence and names every blocking dimension. `run.py` emits a
`paper_gate.csv` and a `strategy_specs.json` (the deployable contract) when anything
passes. Zero-cost runs are refused with an explicit reason.

---

## 2. Verified correctness bugs fixed

| Bug | Where | Evidence / fix |
|---|---|---|
| **Look-ahead in `ev_convergence`** | `divergence.py` | used `s.shift(-1)` — the NEXT bar's spread — and was pushed as a live tradeable candidate. The no-lookahead audit never tested it, so `NO_LOOKAHEAD = PASS` was a false pass. Now strictly past-only (`\|S[t]\| < \|S[t-1]\|`), and the audit covers the derived columns. |
| **Ragged data: `shift(k)` advanced k ROWS, not k minutes** | `timeframe.py` | long-form option data only has rows when a contract trades. Measured on your CSV: `return_5` spanned **mean 28.5 min, max 5390 min**, 10.35% of rows > 5 min, and `fwd_ret_5m` crossed the overnight gap for **1.36%** of rows. New `align_to_grid` reindexes onto the union session grid built **per day**, so one row == one minute and a forward label cannot cross the session. Prices are never forward-filled. |
| **Feature windows spanned the overnight gap** | `features.py`, `labels.py`, `sequences.py` | grouping was by `symbol` only, so a 120-bar mean and `shift(-5)` reached across sessions. New `features.session_keys` groups by `(symbol, session date)`, and `leakage.py` was made session-scoped to match. |
| **Full-sample quantile bins** | `sequences.py::add_states` | `pd.qcut` fitted bins on the whole sample, so an August bar was labelled using September's distribution — and `state_id` is a traded family. Now a trailing `rolling_percentile`. |
| **`volume_percentile` described bar t-1** | `features.py::roll_pct` | `s.shift(1).rolling(H).apply(lambda w: (w <= w.iloc[-1]))` excluded the current bar, so `volume_shock` fired on the *previous* bar's percentile (correlation 0.9997 with the lagged series). Now includes the current bar and is vectorised (this alone dominated runtime). |
| **MFE/MAE rolled backward** | `labels.py` | `s.shift(-1).rolling(w)` covers `[t-w+2 .. t+1]` — it included **pre-entry** bars and missed the forward horizon. At `t=0, w=5` it returned 60% instead of the true forward 100%. |
| **Labels claimed a horizon they did not have** | `labels.py` | `min_periods=1` gave the last bars a shorter horizon. Now `min_periods=w`. |
| **Optimistic stop fills** | `backtest.py`, `engine.js` | the old code tested only whether the bar *touched* the level and filled AT it. Reproduced: long @100, next open 40, `sl=0.5%` → −0.5% instead of the real gap loss. Now fills at the bar open when it opens beyond the level (`SL_GAP` / `TP_GAP`). |
| **Entry at the signal bar's close** | `backtest.py` | you cannot trade the close you just used to decide. Now `entry_fill="next_open"` by default, and `signal_time` is recorded separately from `entry_time`. |
| **Short returns used the wrong denominator** | `backtest.py` | `entry/exit*100-100` = `(entry-exit)/exit`; corrected to `(entry-exit)/entry`. |
| **Zero costs everywhere** | `backtest.py`, `costs.py` | `cost=0.0`, fingerprint said `cost=ZERO`. Now a full Indian options model (brokerage, STT, exchange, SEBI, stamp, GST, slippage), and the paper gate refuses zero-cost runs. |
| **`direction` was cosmetic** | `run.py` | always `"long"` and never passed to the backtester, so short premium was never tested. Now a real parameter, with `--allow-short` to also test mirrored variants. |
| **No session/expiry discipline** | `backtest.py` | positions could be held across the session boundary. Now squared off (`EOD`) and clipped to the contract's last traded day. |
| **`final_state` inverted** | `run.py` | survivors produced `DISCOVERY_EDGE_OOS_FAILED`; no survivors produced `DISCOVERY_COMPLETED_NO_EDGE`. |
| **`run_filters` crashed on zero candidates** | `filters.py` | reproduced `KeyError: 'events'`. Now missing-column and empty-frame safe. |
| **`synchronized_snapshots` was a misnomer** | `ingestion.py` | it counted timestamps with **at least one** contract, so a chain that is jointly complete **1.9%** of the time reported `CHAIN_STRUCTURE = AVAILABLE`. Now separate `union_snapshots` / `joint_snapshots` / `median_contracts_per_snapshot`, computed on **printed** bars, and gated on the focus chain's own joint completeness. |
| **Cross-expiry contamination** | `relationships.py` | `df[col] = ts.map(spread)` wrote expiry A's spread onto expiry B's rows. Now assigned per `(expiry, option-type)` group. |
| **Breadth had a different denominator every minute** | `relationships.py` | raw counts → not comparable across timestamps. Now a percentage, with counts kept alongside. |
| **Union events were near-always-true** | `divergence.py`, `run.py` | `ev_convergence` ORed ~24 heterogeneous spreads and fired on **21,371 of 47,370** bars (45%). Now pushed **per spread column** (`CV:` / `CU:` candidates). |
| **`concentration` was meaningless for a losing strategy** | `robustness.py` | it divided the top-N sum by the total, which for a negative total is a ratio of losses. Now share of **gross profit**. |
| **`time_split` could not work** | `robustness.py` | it ANDed the full-frame mask with a masked-index series — a NaN object array. Reproduced; fixed alignment. |
| **`exit_independence` silently used another strategy's mask** | `run.py` | for BREADTH/SEQ/STATE/LL candidates the feature is not a column, so it fell back to `e_expansion`. Masks are now stored by candidate id. |
| **`robustness_score` was mostly constant** | `run.py` | `param`/`time`/`contract` were hardcoded to 0.5 and `tstab`/`pert` were computed then discarded. Now measured. |
| **~18 `DiscoverySettings` fields had no consumers** | `settings.py` | the `configuration_hash` claimed reproducibility for knobs that did nothing. Every field is now read. |
| **`exit_config_hash` / `finalize_ledger`** | `ledger.py` | cost was subtracted from a *percent* return as if it were currency. Cost is now a percent and part of the fingerprint. |
| **Paper tier used the raw p, F11 used the adjusted p** | `run.py` | a row could be `OOS_SURVIVED` while F11 rejected it. The tier now uses the BH-adjusted p. |
| **`PF=inf` produced invalid strict JSON** | `metrics.py` | non-finite values are now written as `NA`. |

### Added diagnostics

`EXIT_GRID_VS_COST` answers the question that decides whether any of this can trade:
a stop-out realises `-(sl + cost)` and a target hit `+(tp - cost)`.

```
median entry premium=769.1  median round-trip cost=0.875%  grid SL=0.5% TP=1.0%
net win=0.125%  net loss=-1.375%  break-even WR=91.7%  VIABLE=False
```

**The default 0.5%/1.0% grid needs a 91.7% win rate before any edge is counted.**
That is why every candidate is net-negative — it is arithmetic, not signal quality.
Widening to 2.5%/5.0% drops break-even to 45%, and the pipeline confirms it is then
VIABLE while still finding that these particular signals do not clear it.

---

## 3. How to verify

```bash
TMPDIR=/tmp python3 -m pytest tests_discovery -q          # 39 passed
python3 -m xbost_option_discovery.run \
  --path "Data test/banknifty_options.csv" --cost-preset BANKNIFTY_OPT
```

`tests_discovery/test_regressions.py` pins each bug: the surrogate on a planted edge,
`ev_convergence` invariance to future bars, causal state bins, session-grid labels,
forward MFE/MAE, gap fills, next-open entry, short returns, EOD square-off, cost
scaling, zero-cost refusal, the derived paper gate, the embargo and the exit-grid
economics.

### Before / after on your dataset

| | before | after |
|---|---|---|
| candidates | 41 | 42 |
| OOS survivors | **0** | 0 (raw p min 0.035 → BH-adjusted 0.975 over 42 tests) |
| `perm_p_adj` min | 1.000 | 0.975 |
| raw `perm_p` spread | noise | 0.035 – 0.990 (a real distribution) |
| exit-cap-dominated | **41 / 41** | 10 / 42 |
| `final_state` | `DISCOVERY_EDGE_OOS_FAILED` | `PROMISING_EDGE_NEEDS_MORE_DATA` |
| paper gate | impossible by construction | derived, explains each blocker |
| runtime | — | 69 s |

**Read this as a result, not a regression.** The old 0 survivors was an artifact. The
new 0 survivors is a real statistical verdict: with 42 candidates tested on 15 usable
discovery days, nothing survives BH correction, and the exit grid cannot pay for its
own cost. Correctly measured, this dataset does not contain a deployable edge.

### Cross-dataset check — `public/nifty_options.csv`

The engine is dataset-driven, so it was re-run unchanged on the Nifty file (different
underlying, 42 different contracts, different premium scale). It generalises, and the
honest gates fire where they should:

```
focus_chain_completeness=0.3515            -> DATA_HEALTH status=DATA_PARTIAL (was silently DATA_VALID)
median entry premium=228.9  round-trip cost=1.564%
net win=-0.564%  break-even WR=NA  VIABLE=False
```

The break-even win rate is **NA** because the take-profit (1.0%) is *smaller* than the
round-trip cost (1.564%) — on a Rs.229 Nifty premium a 1% target does not even cover
the friction. A 75-lot at that premium pays ~Rs.269 round trip. Two datasets, two
different premium scales, the same conclusion: the default exit grid is unusable.

---

## 4. JS engine — the same bugs, mirrored

The web engine had the same root causes, so the GUI was reporting the same false
results:

| Fix | Where |
|---|---|
| `OD.surrogateP` permuted the return series (identical degeneracy). Replaced with `OD.surrogateMaskP(mask, labels, blocks, nPerm, seed)`, an event-time permutation that rolls the mask within `(symbol, day)` blocks and uses sample std (ddof=1) for the Sharpe stat. The old function is retained but returns NaN with `deprecated: true`. | `public/discovery-engine.js` |
| `robustness.js::surrogateTest` relied on `_phaseRandomize`, which preserves the power spectrum and therefore mean and variance — Sharpe is invariant, so p was never evidence. | `public/robustness.js` |
| `bootstrapCI` used `Math.random()`, contradicting the seeded-RNG contract. Now seeded. | `public/robustness.js` |
| Broken sort comparator `(a.symbol < b.symbol ? -1 : 1) \|\| a.ts - b.ts`: for EQUAL symbols the ternary returns `1` (truthy), so `\|\|` short-circuits and **timestamps were never compared**. Cluster gaps — and therefore `nClusters` — were computed on arbitrary order. | `public/discovery-engine.js` |
| Gap-through-stop filled AT the stop level. Verified end-to-end: long @100, next bar opens 40, `slPct:1` → now `SL_GAP` at 40, pnl −60 (was −1); a bar that opens INSIDE the level and trades through it still fills at the level (`SL`, pnl −1); a bar that never reaches it is untouched. Also added the missing `entryPx > 0` guard. | `public/engine.js` |
| `paper_eligible` was hardcoded `false`. Now `OD.paperGate` derives it from measured evidence with the same check names as the Python gate, so a zero-cost run is refused with an explicit `cost_model_real` blocker. Applied to every candidate; boards, `finalReport` and `statusBar` are all derived. | `public/discovery-engine.js` |
| Population std (ddof=0) → sample std, matching Python. | `public/discovery-engine.js` |
| The tier was assigned from the RAW p while the hard gates used `perm_p_adj`. New `OD.recomputeStatusFromAdjusted` recomputes `final_status`/`failure_reason`/`TIER` from the adjusted p right after BH; `TOP_MT` is a guaranteed superset of survivors. | `public/discovery-engine.js` |
| Tests that *asserted* the paper gate stayed false now assert it is derived and self-consistent, and that a zero-cost run can never be promoted. | `test/discovery.test.js`, `test/robustness.test.js`, + new `test/surrogate.test.js` |

`node --test test/` → **134 passing, 0 failing, 0 skipped, exit 0** (~8.3 min;
`discovery.test.js` runs several full discovery passes at module scope, which is
nearly all of it). `web/public/*` is byte-identical to `public/*` and `web/dist` was
rebuilt, so the served GUI carries the fixes.

Two honestly-flagged residuals on the JS side:

* `robustness.js::surrogateTest` only receives trade P&Ls — it has no mask or label
  series, so it uses a **sign-flip randomization** rather than the event-time
  permutation. The statistic is not invariant under that null, so it is a valid test;
  the exact event-time permutation is used in the discovery engine where the mask
  exists.
* `checkStop` still steers the *search budget* using the raw-p status mid-run; only
  the reported tiers and gates are BH-corrected. That affects how the search spends
  its rounds, not the final verdict.
* The JS cost model is still hardcoded `ZERO`, so the JS gate is correctly closed for
  every run today. Porting `costs.py` to JS is what would let a GUI run open it.

## 5. What still stands between you and paper trade

1. **The exit grid must be wider than the cost.** Verified by arithmetic above. Re-run
   with e.g. `--exit-sl 2.5 --exit-tp 5 --hold-bars 15` before drawing conclusions.2. **More data.** 21 calendar days (15 after the split and embargo) cannot support a
   42-candidate search. Add several expiries and a few months of history.
3. **No underlying reference in Python.** The JS engine already computes
   `moneyness_pct`, `moneyness_band`, ATM selection and `und_ret`
   (`public/discovery-engine.js`, `OD.underlyingFeatures`). Python has none of it, and
   `Data test/banknifty_futures_1m.csv` is not used anywhere. Without spot you cannot
   separate delta from vega, and strike selection at deployment has no rule.
4. **A paper runner.** The pieces that exist: cost model, gap-aware fills, position
   ledger, `strategy_specs.json`, and `paperEligible` in `public/engine.js`. Missing:
   a spec consumer that replays the strategy and maintains orders/positions, and a
   `/api/paper/*` surface with persistence and a scheduler.
5. **Server hardening** (`server.js`): default `ADMIN_PASS`/`SESSION_SECRET`, no
   `secure` cookie, MemoryStore, no session `regenerate()`, no `trust proxy` (the
   login throttle is one global bucket), synchronous bcrypt, unauthenticated
   log-injection endpoint.
