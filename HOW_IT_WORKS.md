# How XBOST Works — Full System Guide

What XBOST is: a login-gated quant research terminal for Nifty/BankNifty
(and equities) 1-minute OHLCV data. It does **research, not live trading**:
upload CSVs, run grid searches and discovery pipelines, validate out-of-sample,
and promote only evidence-backed ideas toward paper. Four terminals share one
shell: **Futures grid**, **Option Discovery**, **Buy Only**, **Options Lab**.

```
browser (React SPA, web/dist) ──HTTPS──▶ node server.js (auth gateway)
   │  /engine.js, /worker.js, /robustness.js, /discovery-*.js (guarded static)
   │  /api/* (login, users, buyonly, client-error)
   │
   ├─ Futures/Options Lab: grid search runs IN BROWSER (Web Worker + engine.js)
   ├─ Discovery: runs IN BROWSER worker (discovery-engine.js), isolated tab
   └─ Buy Only: thin client; real run happens SERVER-SIDE (python CLI over SSE)
```

---

## 1. Access, server, deployment

- `server.js` — Express gateway. Session login (`users.json` store, bcrypt,
  `ADMIN_USER`/`ADMIN_PASS` bootstrap, `SESSION_SECRET`). Login page + `/api/login`
  public; React bundle (`/assets/*`) public so the login form boots; engine /
  worker / data files and all other APIs need a session.
- SPA shell rule: `GET /`, `/index.html`, `/login.html`, `/users.html` always
  serve `web/dist/index.html`; the hash router (`#/`, `#/futures`,
  `#/discovery`, `#/buyonly`, `#/users`, `#/login`) decides what renders.
- `POST /api/buyonly` — session-gated; spawns
  `python3 -m xbost_option_discovery.run_buyonly` and streams stdout as SSE
  (`log` / `progress` / `done` / `error`). Concurrency cap, CSV size cap,
  run timeout, temp-dir cleanup; spawn failure returns an error event, never
  crashes the server.
- `POST /api/client-error` — public, throttled beacon so dying browser tabs
  leave evidence in server logs.
- `Dockerfile` — two stages: `webbuild` (`npm ci` + `vite build`, prebuild
  syncs canonical JS + stamps build info), runtime (`node:22-slim` + `npm ci
  --omit=dev`, copies `server.js`, `buyonly_api.js`, `buyonly_fake.js`,
  `public/`, `web/dist`, plus `python3`/`pandas`/`numpy` and the
  `xbost_option_discovery/` package for Buy Only runs).
- `railway.toml` — Dockerfile builder, `node server.js`, healthcheck
  `GET /login.html` (must be 200, zero redirects), restart on failure.
- `.github/workflows/ci.yml` — `npm test` (node), web typecheck + vitest +
  build, auth-smoke (shell served, bundle public, engine guarded, post-login
  shell + worker files, user CRUD), then `docker build`.
- `web/scripts/sync-engine.js` (prebuild) — copies canonical
  `public/{engine,worker,robustness,discovery-engine,discovery-worker}.js`
  and sample/bundle data into `web/public/` so the app and workers run
  byte-identical code; stamps `src/lib/buildinfo.ts`.

## 2. Data in

- Upload once on Home (`web/src/lib/data.ts`); futures and options files
  coexist, each terminal only runs its own datasets. `public/` also ships
  `sample-banknifty-options.csv` and precomputed `discovery-bundle.json` /
  `buyonly-bundle.json`.
- **Long format:** one row per contract bar
  (`timestamp/symbol/strike/option_type/expiry/open/high/low/close/volume`,
  generous aliases: `ts/ist/date`, `otype/cp`, `contract/instrument`,
  `close/last/ltp/settle`, `vol/qty`, `oi`, `bid/ask`, `underlying/spot`).
- **Wide format:** one row per timestamp, `<contract>_<field>` columns
  (e.g. `54700CE_o…54900PE_v`) + `expiry` column. Contract tokens parsed
  (type suffix → expiry infix → trailing strike → underlying prefix).
- Canonical Python ingestion: `ingestion.load_dataset` → `detect_layout` →
  `load_long` / `load_wide` → one canonical frame
  (`timestamp|expiry|strike|option_type|symbol|open|high|low|close|volume[+oi|bid|ask|underlying]`);
  integer timestamps parsed as epoch with magnitude-inferred unit (s/ms/ns).
  `detect_chain` (contracts/strikes/types/expiries, snapshot completeness),
  `research_universe` (every valid canonical contract — focus never deletes),
  `compute_priority` (most-liquid N strikes order the frontier queue only),
  `module_availability` (each downstream module reports AVAILABLE/UNAVAILABLE,
  never assumed).
- JS ingestion (`engine.js`): multi-format OHLCV parse + per-contract split,
  IST-pinned resampling to 1–15 m.

## 3. Futures grid terminal (browser engine)

Orchestrated by `web/src/lib/runner.ts runGrid()`:
1. **Grid build** — enabled indicators × timeframes × parameter ranges
   (`buildGrid` or Halton quasi-random + Bayesian EI refine), SL/TP expansion,
   exit/carry dims, trial cap.
2. **Data prep** — date-filtered 1 m per symbol; in-sample slice at `wfSplit`
   when walk-forward is on; resample per timeframe; combine session / expiry /
   IV-rank / trade-window masks; regime routing (ML or day-rule); underlying
   signal source optional.
3. **Backtest** — single shared Web Worker (`worker.js` + `engine.js`,
   heartbeat watchdog, throttled progress) with main-thread fallback; 30+
   indicators; hill-climb + Bayesian proposals; AND-pair combos of leaders;
   composite `strategyScore` ranking with integrity audit.
4. **Walk-forward** — untouched OOS tail, purged K-fold (`purgedFolds`, K=3)
   or contiguous fallback; per-row `oosNet/oosWR/oosN/foldWins/survived`.
5. **Robustness** (`robustness.js`) — 0–10 score, surrogate p, parameter
   sensitivity (knife-edge demotion).
6. **Trials-aware inference** — bounded `effectiveN` rebuild, per-observation
   Sharpe variance, best-of-N null bar, per-row deflated Sharpe (DSR);
   `validated = DSR ≥ threshold AND OOS survived`; LEADS pool (ranked,
   validated or not, with reasons) + VALIDATED board.
7. **Paper gate + adaptive tiers** — champion must clear DSR, robustness,
   surrogate, sensitivity, OOS; failures can escalate Tier A→B→C and re-run.
8. **Outputs** — leaderboard CSV (with DSR/validation columns), leads CSV,
   trades CSV (IST, reasons, regimes, MAE/MFE), run log + offline
   `research_<run_id>.json` audit (replayable).

## 4. Option Discovery (browser engine, independent tab)

`web/src/pages/Discovery.tsx` + `discovery-worker.js` + `public/discovery-engine.js`
(~4700 lines, zero futures imports). Frozen pipeline order:

`RAW → NORMALIZATION → FEATURES → DISCOVERY → TRADING-RULE → TRAIN →
VALIDATION → ROBUSTNESS → FROZEN OOS → MULTIPLE TESTING → PAPER GATE`

- **Features (all past-only, session-grouped):** returns/accel/streaks,
  ATR/range/volume shocks, baselines, type relationships (CE↔PE),
  cross-strike spreads, breadth, divergence/convergence/catchup events,
  atomic + combo events, sequences, chain states; forward labels
  `fwd_ret_1…30m`, MFE/MAE strictly after the bar.
- **Search:** frontier queue with family quotas, explore/exploit split,
  hypothesis registry (dedup by canonical hash), convergence checker,
  watchdog, checkpoints/resume; depth-1 atomic specs → combos → staged
  exit discovery (STOP×TARGET×TRAIL×TIME on validation only, return-path
  guided); Levels A (single-contract) → B/C (same/cross-expiry) → D
  (cross-symbol transfer, pool==sum check).
- **Honesty machinery:** chronological discovery/refinement/OOS splits with
  embargo; lookahead audit (recomputes features from raw bars, aborts on
  true lookahead); exit-propagation gate (different TPs must diverge);
  ledger-hash + metric-recompute checks; event-time permutation surrogate
  (roll the event mask inside (symbol, day) blocks, labels untouched);
  BH/Holm/Bonferroni multiple testing with `perm_p_adj` as the decision;
  DSR + effectiveN reported alongside; F1–F13 filter log
  (`BLOCKED_NO_INPUT` / `FAIL_ALL_REJECTED` / `PASS`).
- **Verdicts:** `final_status` (`VALIDATED_EDGE_FOUND`,
  `NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET`, `SEARCH_BUDGET_EXHAUSTED`,
  `BLOCKED_*`, …); paper eligibility **derived** from measured evidence
  (real cost model, OOS, adjusted p, robustness, concentration) — never
  assigned. Artifacts: `candidates.csv`, `report.md` (16+ sections),
  dashboard HTML, `tab_bundle.json`, `surrogate_distributions.json`,
  `exit_audit.csv`, checkpoints.

## 5. Python discovery engine (`run.py`: unconstrained universe + tracks)

Same frozen pipeline as §4, implemented in `xbost_option_discovery/run.py`
with the full honesty battery (splits/embargo, lookahead + selector audits,
exit propagation, ledger hashing, event-time surrogates, BH/Holm/Bonferroni,
DSR/effectiveN, robustness 0–10, edge ladder, evidence-derived paper gate).

- **Research universe = every valid canonical contract**
  (`ingestion.research_universe`, instrument-level so same strike/type
  across expiries never merges). `compute_priority` (most-liquid N strikes)
  only orders what the dual frontiers try first; `LIQUIDITY_FILTER=FALSE`
  is printed every run. No ATM/OTM/ITM, CE/PE, strike, or expiry filter.
- **Track A (OHLCV-only):** single-contract price/volume families, enforced
  in code at mask resolution (`tracks.track_allows_column` + selector/
  scope rules); cross-contract/OI/bid-ask/underlying columns resolve to an
  empty mask with a recorded `track_violation`.
- **Track B (all available data):** everything in A plus cross-contract
  relationships (type/cross-strike/breadth/lead-lag/divergence), OI-shock
  events when OI prints exist, and scope/selector families. Absent fields
  report `UNSUPPORTED_METHOD`/`INSUFFICIENT_VARIATION`, never fabricated.
- **Contract selection is searchable:** static scope hypotheses
  (side/expiry/strike/contract, priority-ordered, budget-capped) plus
  dynamic trailing rank selectors (volume/momentum rank-1/top-3, audited
  against history-only recomputation), plus scope-restricted combo
  children ("signal here, trade there").
- **Independent scheduling, shared statistics:** one frontier + method
  memory per track, exit-job reserve per round, coverage-driven priority
  for untouched contracts; ONE global registry/counter (track-namespaced
  `A_H…`/`B_H…` IDs) so BH/DSR span both tracks.
- **Reporting:** `DISCOVERY_UNIVERSE` (totals + searched), per-track
  hypotheses/evaluated/coverage/exit-jobs/validates/rejects,
  `SEARCH_BUDGET` (configured vs tested per dimension), checkpoints carry
  per-track frontiers + coverage + global counts (resume never duplicates
  or resets).
- CLI: `--tracks A|B|AB`, `--focus-strikes` (priority depth only),
  `--max-scope-contracts`, `--no-selectors`, `--surrogate-perms`,
  `--max-exit-combos`, `--max-runtime-seconds`.

## 6. Buy Only (server-side Python engine)

`web/src/pages/BuyOnly.tsx` is a thin client over `POST /api/buyonly` (SSE).
The real engine is `xbost_option_discovery/buyonly/` driven by
`run_buyonly.py` CLI stages: config fingerprint → DATA (canonical ingest,
OI/futures presence, put-call-parity ATM when no futures, straddle-proxy
underlying, causal session features) → REGIMES (TRENDING/COMPRESSING/CHOPPY,
each authorizing one hypothesis) → SIGNALS (4 setups: VOLATILITY_COIL,
OI_VELOCITY, LIQUIDITY_FLUSH, VWAP_SNAP_BACK; fill next-bar open) →
ADAPTIVE+EXECUTION (event-driven backtest, structure stop → breakeven →
profit-lock → 1-candle trail, real costs always charged, loss-streak halt) →
STATISTICS (bootstrap CI, re-timing permutation test — ledger permutation is
provably a no-op so timing is permuted instead, sensitivity grid) → VERDICT
(`VALIDATED_EDGE` iff PF>1 ∧ CI excludes 0 ∧ timing p<0.05, else
`NO_VALIDATED_EDGE`, never optimistic). Writes `ledger.csv`,
`by_hypothesis.csv`, `summary.json`, `report.md`, `logic_map.md`,
`buyonly-bundle.json`, `run_log.txt`, `audit.jsonl`.

## 7. Options Lab

Per-contract backtesting tile (same browser runner, `instrumentMode =
'options'`): ATM auto-select, expiry-day exclusion, premium floor, buy-only
mode, ATM±1 bake-off, CK/ATR/BE exits.

## 8. Shared methodology (the rules everything obeys)

- **No lookahead, ever:** features use bars ≤ t; labels/exits strictly after;
  session-grouped windows; labels never leak into features (audited).
- **Costs are explicit:** zero-cost runs are labeled RESEARCH and can never
  validate; paper requires a real cost model.
- **OOS is frozen:** fixed before evaluation, never optimized against;
  purged/embargoed folds; thin folds skipped, never counted as passes.
- **Multiple testing is the decision:** raw p never promotes; BH-adjusted p
  (plus DSR vs the best-of-N bar) gates survivors.
- **Robustness is scored, not asserted:** 0–10 battery (signal, sample,
  parameter neighborhood, time, contract, OOS, exits, concentration,
  best-event removal), with hard caps and vetoes.
- **Fail closed:** empty inputs → `BLOCKED_*`, thin samples → untestable
  (not failures), every rejection carries a named reason; verdicts never
  claim more than the evidence.

## 9. Code map

- `public/engine.js` — JS quant library (parse, resample, 30+ indicators,
  masks, regime router, signals, backtester, metrics, grid builders,
  purged folds, Bayes refine, DSR/effectiveN math, paper gate, profiles).
- `public/discovery-engine.js` — option discovery pipeline (see §4).
- `public/robustness.js` — robustness battery shared by UI thread + worker.
- `web/src/*` — pages (Home, Discovery, BuyOnly, Login, Users), runner,
  zustand store, engine facade, charts (lightweight-charts), AG Grid
  leaderboard, exports.
- `xbost_option_discovery/*` — Python research package: `ingestion`,
  `features`, `relationships`, `divergence`, `sequences`, `labels`,
  `feature_quality`, `capability`, `identity`, `timeframe`, `settings`,
  `validation`, `leakage`, `backtest`, `costs`, `ledger`, `metrics`,
  `robustness`, `generalization`, `return_path`, `exits`, `search`,
  `multiple_testing`, `inference`, `filters`, `research_state`,
  `edge_ladder`, `paper`, `reporting`, `run.py`, plus `buyonly/` and
  `run_buyonly.py`.
- Tests: `test/` (node: discovery, engine, inference, robustness, surrogate,
  buyonly-api), `tests_discovery/` (structural, regressions, dynamic,
  identity, adaptive, inference, buyonly, buyonly-audit), `web` vitest.
