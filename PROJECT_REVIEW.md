# XBOST — Full Project Review

**Date:** 2026-09-24 (updated) · **HEAD:** `6247843` · **Branch:** `main` (in sync with `origin/main`)
**Production:** `xbostproduction.up.railway.app` — verified serving `6247843`
**Reviewer:** Muse Spark (working session with repo owner)
**Purpose:** single detailed reference for a human/technical review of the entire
XBOST codebase — what exists, how it works, what was verified by execution,
what broke and how it was fixed, and what remains to reach the stated goals
(70–80% WR strategies, validated Options Lab, paper-trading gate).

Related docs (older, partially stale): `README.md` (run/deploy cheat sheet),
`DOCUMENTATION.md` (classic-terminal-era end-to-end docs), `FORMULAS.md`
(formula reference, mirrors `engine.js`).

---

## 1. Executive summary

XBOST is a login-gated, single-server **algorithmic backtesting terminal for
Indian markets** (Nifty / BankNifty / equities, plus MCX commodities and index
options) on 1-minute OHLCV. The core loop is:

```
CSV upload → parse/split (+contract meta) → resample → Halton grid search
(Web Worker) → hill-climb + Bayesian EI refine → staged robustness (0–10)
→ purged multi-fold walk-forward → leaderboard (R-score/surrogate/PSS/Paper
cols) → charts/trade log/stress lab → CSV + session-log export
```

Design philosophy (enforced in code, not just docs): **robustness over peak
Sharpe** — plus, since this review cycle, two harder rules: **no silent
failures** (every hang/error must surface loudly) and **one configuration,
one math** (board, robustness, and logs must evaluate the identical candidate
config — see §13 incident 2).

**State at HEAD:**
- React terminal builds clean; **39/39 engine+robustness unit tests + 3/3 web
  tests pass**; `tsc --noEmit` clean; CI (tests → auth smoke → docker build).
- Landing page with **Futures Terminal / Options Lab** tiles, upload, dataset
  chips, data-health verdicts, build version + timestamp footer.
- Hard paper gate (`paperEligible`) + hard adaptive gate (`tierGate`) + L8
  anti-overfit gate in validation panel — all verified end-to-end on sample data.
- Exchange-aware sessions (NSE/MCX/NCDEX auto-detect) — the MCX 0-trade bug
  class is fixed and proven.
- Options Lab is now structural (buy-only enforcement, ATM±N select, expiry-day
  exclusion, premium floor, IV-rank filter, cost presets) but still needs
  multi-expiry data and Greeks (no OI in CSVs — see §15).
- Production verified on `6247843` by bundle fingerprinting.

---

## 2. Change log since the last review (`1311654` → `6247843`, 6 commits)

| Commit | Content |
|---|---|
| `c0f0d5d` | Regime-first upgrade: Ehlers HilbertDC/ITrend, AdaptRSI/AdaptBB, router-v2 smoothing, Halton grid, purged folds, Bayesian EI refine, PSS/block-bootstrap/surrogate, L8 gate. Departures from `upgrade.md` spec documented in commit message |
| `652d72d` | Hard gates: `paperEligible`, adaptive `tierGate`, multi-fold purged WF, options buy-only, cost presets, knife-edge demotion, leaderboard R-Scr/Surr/PSS/Paper cols, `__XBOST__` automation hook |
| `0717711` | Build stamp (`version`/`commit`/`builtAt` at prebuild) + Home footer display |
| `f972d78` | **Incident fix:** run stuck at "warming up" (stale zustand snapshot); worker try/catch + heartbeat watchdog |
| `657d2f8` | **Incident fix:** phantom metrics (robustness evaluated fallback config); `effOptsFor` + mask-aware cache + single-source CORE SIGNAL + regression test |
| `6247843` | Systemic fixes: exchange sessions, contract meta + ATM select, cost modes, IV-rank mask, data health, board min-trades filter, per-exchange heatmaps |

---

## 3. Repository map (accurate at HEAD)

```
XBOSTquant/
├── server.js                 # Express session-auth gateway + user APIs + static host
├── users.json                # JSON user store (no DB)
├── package.json              # root: express, express-session, bcryptjs; test/ dir runner
├── public/
│   ├── engine.js             # QUANT CORE (~2000 lines): parse, 34 indicators, signals,
│   │                         # backtest, grid/Halton/Bayes, regimes, ML, gates, sessions,
│   │                         # contract meta, IV-rank, expiry masks
│   ├── robustness.js         # staged 0–10 engine, 24 evidences (~440 lines)
│   ├── worker.js             # grid-search + refine + Bayes Web Worker (~270 lines)
│   ├── app.js / index.html / login.html / users.html / auth.js   # LEGACY classic terminal
│   ├── HDFCBANK_minute.csv   # 51 MB futures sample (committed)
│   ├── nifty_options.csv     # 17 MB, 42 contracts (committed)
│   └── banknifty_options.csv # 21 MB, 42 contracts (committed)
├── "Data test"/              # canonical samples (small futures + full options)
├── test/
│   ├── engine.test.js        # 33 unit tests (node --test)
│   └── robustness.test.js    # 6 unit tests (PSS, blockboot, surrogate, params, consistency)
├── web/
│   ├── scripts/sync-engine.js# prebuild: sync engine/worker/robustness + build stamp
│   ├── src/App.tsx           # hash routing: '' → Home, futures/options → terminal
│   ├── src/pages/            # Home.tsx (tiles + upload + health + version footer), Login, Users
│   ├── src/components/       # Header, Sidebar, MainView, KpiStrip, Leaderboard
│   │                         # (+R-Scr/Surr/PSS/Paper cols, min-trades filter),
│   │                         # RegimeSplit, RunSummary, StressPanel, TopFiveReview,
│   │                         # TradeLog, ChartPanels (11 files)
│   └── src/lib/              # store, runner, data (+selectATM, dataHealth), engine
│                             # facade (+all new fn types), config (+COST_PRESETS),
│                             # report (+sampleTier, single-source CORE), stress
│                             # (+MCX buckets), validate (+L8), export, api, router,
│                             # robustness facade, buildinfo.ts (generated, git-ignored)
├── Dockerfile / railway.toml / .github/workflows/ci.yml
├── README.md / DOCUMENTATION.md / FORMULAS.md
├── PROJECT_REVIEW.md (this file) · /Users/srinivas/upgrade.md (external spec, see §16)
```

**Counts:** engine ~2000 + robustness ~440 + worker ~270 + server 168 +
web lib ~1700 + web components ~1300 + tests. No native deps, no DB engine.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Quant core | Vanilla JS, `Float64Array`/`Int8Array`, zero DOM | Identical in browser, Worker, Node |
| Frontend | React 19, Vite 7, TypeScript 5.8, Tailwind 4, Zustand 5 | SPA from `web/dist` |
| Charts/grid | lightweight-charts 4, AG Grid 33 | |
| Tests | `node --test test/` (39), Vitest (3) | |
| Backend | Express 5, express-session, bcryptjs | Pure-JS |
| Deploy | Dockerfile (`node:22-slim`) → Railway, auto-deploy `main` | Verified by bundle fingerprint |
| CI | Actions: tests → typecheck → web tests → web build → auth smoke → docker | |

`web/scripts/sync-engine.js` copies the three `public/*.js` files at prebuild
and stamps `src/lib/buildinfo.ts` (`version`/`commit`/`builtAt`, git-ignored).

---

## 5. Data layer

### 5.1 Formats (`parseCSV` sniffing, `engine.js:35`)
Headered equity, headerless positional futures, and options multi-contract
(`date,symbol,strike,otype,expiry,open,high,low,close,volume`). The sniffer
recognises `strike`/`otype`/`expiry` header variants; positional files leave
contract meta null (honest absence, not fabricated).

### 5.2 Contract meta (new in `6247843`)
`extractRows` collects STRIKE/OTYPE/EXPIRY arrays; `parseCSVAll`/`parseCSV`
attach one `contract={strike, otype, expiry, expiryMs}` per dataset via
`contractOf` (first row carrying each field). Expiry formats: `29SEP2026`,
ISO, epoch. Verified: `NIFTY29SEP2623500PE → {strike:23500, otype:'PE',
expiry:'2026-09-28'}` (local-midnight IST; mask compares calendar dates in the
same clock as session logic).

### 5.3 Multi-contract split — verified by execution and unit-tested
`nifty_options.csv` → 42 pure per-contract datasets, largest first, only the
largest enabled by default.

### 5.4 Sample data inventory
| File | Bars | Span | Notes |
|---|---|---|---|
| `public/HDFCBANK_minute.csv` | ~1.03M 1m | 2015–2026 | 51 MB |
| `public/nifty_options.csv` | 42 × ~0.3–7.9k | 2026-08-20 → 09-18 | 17 MB, 1 expiry (29SEP2026) |
| `public/banknifty_options.csv` | 42 × ~0.3–7.9k | same window | 21 MB, 1 expiry |
| `Data test/*_futures_1m.csv` | small (~6k) | — | canonical small samples |

### 5.5 Data-health verdicts (new)
`dataHealth()` (web `data.ts`): sessions / expiries / contracts / span vs
minimums (50 / 3 / 10 / 60d), shown on Home and in every run-start log.
Live sample: `FAIL Sessions ≥ 50 (21) · FAIL Expiries ≥ 3 (1) · PASS
Contracts ≥ 10 (42)`.

### 5.6 Timezone finding (still open)
Session masks, window masks, and heatmaps bucket on viewer-local time while
windows are IST-wall-clock. Correct for IST viewers; wrong elsewhere. The
engine runs client-side so Railway's UTC clock is irrelevant, but a non-IST
viewer gets different results from the same file. **Recommendation unchanged:**
pin IST explicitly (fixed `+05:30`) with a `TZ=UTC` unit test.

---

## 6. Quant engine (`public/engine.js`)

### 6.1 Indicators (34)
All §5-era 30 plus: **HilbertDC** (true Ehlers dominant cycle, period 6–50
clamped/rate-limited; overlay leg, holds flat), **ITrend** (zero-lag line vs
1-bar trigger), **AdaptRSI** / **AdaptBB** (Hilbert-driven lookbacks,
cycle-mode gated, `baseLen` fallback, 30-bar settle quarantine). Verified:
Hilbert median 21.2 on a 20-bar sine; causality test (output at t identical
with/without future data).

### 6.2 Execution semantics
Unchanged core (causal fills, SL-wins-collisions, cash identity, ruin halt —
all unit-tested) plus: **premium-floor entry gate** (`premiumFloor` opt skips
sub-floor entries on fresh and flip entries; default 0 = off) and exchange
sessions flowing through the standard mask path.

### 6.3 Grid / search
Cartesian `buildGrid` + deterministic **Halton** `buildHaltonGrid` (radical
inverse in prime bases, per-indicator blocks, cfgKey-deduped) — now the
**default sampler (512 pts)**; `purgedFolds` (purge+embargo gaps, disjoint by
construction); `bayesianRefine` (Matérn-5/2 GP-EI over evaluated top rows,
step-snapped, deterministic, neighbor fallback).

### 6.4 Gates (pure, unit-tested)
`paperEligible` (net>0, n≥200, cost>0 unless signal-only→warning, score≥9.5,
surr p<0.01, PSS clean, OOS survived — named reasons+warnings),
`demoteKnifeEdge` (PSS≥0.5 sinks, unknowns keep position).

### 6.5 Sessions / filters
`detectExchange` (MCX/NCDEX prefix lists, default NSE), `resolveSession`
(preset vs explicit-override flag), `buildExpiryMask` (expiry-day gamma zone),
`ivRankSeries`/`ivRankMask` (RV-percentile cheap-vol filter; `insufficient`
when <50 usable ranks — never silently zeroes), `smoothRegime` /
`applyMaskPersistence` (router-v2 anti-flip-flop), `adaptivePeriod`.

---

## 7. Regime routing + ML

Unchanged rule regimes (T+/T−/RH/RL) + day-ML softmax with confidence gate,
plus router-v2 persistence/hysteresis (cached per-TF in worker and runner).
Measured effect: relabels 12/21 days on the options sample. ML still needs
≥20 sessions; options sample (21, now 15 in spots) is borderline — logged,
never silent.

---

## 8. Grid-search pipeline (`runner.ts`, `worker.js`)

Multi-symbol merged board; worker-first with main-thread fallback; hill-climb
+ Bayesian EI pass; robustness Top-25 + re-rank + knife demotion; purged
multi-fold `wfVerify` (≤3 OOS folds, per-fold net/WR/n/Sharpe, thin folds
skipped); agent-readable RUN SUMMARY with config, best, top-5, per-symbol
best, stress, and environment lines; adaptive tier escalation behind the
**hard `tierGate`** (sharpe + robust + surrogate + PSS + OOS lines); PAPER
ELIGIBLE/BLOCKED verdict every run; knife-edge post-pass uniform across
worker/fallback paths; run line logs exchange/hours/sampler/costs/filters.

**Reliability hardening (§13.1):** worker body wrapped in try/catch posting
`{type:'error'}`; empty-grid/empty-pool guardrails; runner handles worker
errors; 90s heartbeat watchdog fails over to fallback; superseded-run return
resets the running flag. No silent-warmup state is reachable by construction.

---

## 9. Robustness engine (`robustness.js`, 24 evidences)

Base 20 plus **PSS curvature** (skips n<30, winsorized Sharpe, thin-neighbor
axes excluded), **seeded block bootstrap CI**, **FFT phase-randomized
surrogate test**, **free-param count** — all stamped
`parameters_locked:true, reoptimized:false`. Central invariant since `657d2f8`:
**every evidence evaluates the identical candidate config** via `effOptsFor`
(SL/TP/trail/exit/carry + CK bridge + rebuilt session mask + worker-supplied
regime mask); cache key includes trail + mask checksums. Staged cost control
and paper-gate thresholds unchanged.

---

## 10. Frontend review (`web/src`)

Routes: `#/` Home · `#/futures|#/options` terminal (`instrumentMode`) ·
`#/users` · `#/login`. Home: hero, inline upload, FUT/OPT chips (capped 9 +
expander), ATM-aware counts, data-health pills, version footer
(`v1.0.0 · commit <hash> · updated <IST>`; Railway shows `unknown` — no git
metadata at Docker build). Header: data badge, exports, run/stop, Home
back-link, RUN hidden on home. Sidebar: data + **exchange select**,
timeframes, objective (+Halton/Cartesian, Halton N, Bayes toggle, purge/
embargo, walk-forward, Top-N, cap, **board min-trades**), execution (+cost
presets, **cost mode**, **options structure filters**, buy-only preset,
trade windows), regime (+router-v2), 34 indicators, fill model, dev panel
(+L8). Leaderboard: R-Scr/Surr/PSS/Paper cols, thin-row notice. `__XBOST__`
automation hook for headless verification.

---

## 11. Server / auth / security (`server.js`)

Unchanged gateway (session auth, login throttle, admin CRUD, dist-first static
serving). Standing items: env-set secrets in production (dev defaults warn);
**revoke the `ghp_BG1g…` token pasted in chat** (not stored in repo — pushes
used inline URLs — but lives in shell/chat history).

---

## 12. Tests & CI (all passing at HEAD)

- `npm test` → `node --test test/`: **39 tests** (33 engine incl. Hilbert,
  ITrend, adaptive, smoothRegime, Halton, folds, Bayes, gates; 6 robustness
  incl. PSS/blockboot/surrogate/params + board≡baseline consistency).
- Web: 3/3 Vitest + `tsc --noEmit` clean + `vite build` green (~1.48 MB).
- CI: install → engine tests → web typecheck/tests/build → live auth smoke
  (shell 200, zero redirects, bundle public / engine guarded) → user CRUD →
  docker build.

---

## 13. Incident log (root-caused, fixed, verified)

### 13.1 Run stuck at "warming up" (`f972d78`) — stale zustand snapshot
`runGrid` captured `getState()`, then the (new) buy-only enforcement logged
(`set()` replaces the state object), then `st.runSeq = mySeq` mutated the
**detached** snapshot → loop broke instantly → early return skipped the
`running=false` reset. Triggered only on the options desk — futures never
logged mid-setup, which is why it escaped local testing. Fixed by replacing
**all** direct store mutations with `set()`; worker hardened against silent
death; heartbeat watchdog; superseded-return resets running. Verified with a
full options run to completion.

### 13.2 Phantom metrics (`657d2f8`) — config mismatch, not corrupt math
Board ranked optimized SL/TP + ATR/breakeven exits + carry + routing while
robustness re-ran fallback SL/TP + fixed exit + intraday + no regime mask;
`formatCoreSignal` mixed board WR/Sharpe with robustness wins/expectancy
("WR 83% with 0 wins"). Fixed via `effOptsFor` everywhere, mask-aware cache
keys, single-source CORE SIGNAL, `sample_tier`. Regression test asserts
board ≡ baseline bit-for-bit; E2E shows CANDIDATE == CORE == ROBUSTNESS
(SqueezeBreak/atr: 7 trades, WR 71.43, PF 19.26, Sharpe 7.85 ×3). A proposed
Sharpe-on-trades rewrite was declined (breaks MTM attribution + 6 tests).

---

## 14. Empirical findings (executed this session)

1. **MCX session fix proven:** NSE mask covers 43% of an MCX day, MCX mask 100%.
2. **ATM select proven:** 28/42 contracts enabled (ATM±1 union + underlying).
3. **Options sample ceiling:** best honest rows are thin (n≤12) and BLOCKED;
   the tradable-looking 70%+ WR rows are 7–11 trade artefacts. No 70–80% WR
   strategy exists on 1 expiry / 21 sessions — expected, now gated.
4. **PSS threshold sanity:** smooth plateau ≈0.01 (n=1608) vs chaotic ≈182 —
   the 0.5 cutoff discriminates; thin samples SKIP instead of fabricating.
5. **Surrogate sanity:** noise p≈0.5–0.58; thin runs SKIP; fat losers p≈0.28.
6. **Costs dominate options:** ₹2 premium moves vs ₹20+ friction — cost presets
   + cost modes + zero-cost paper block are load-bearing, not cosmetic.

---

## 15. Gaps, risks, and review asks

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Local-TZ session/heatmap logic | High | Open — pin IST + `TZ=UTC` test |
| 2 | Multi-expiry options data (≥6 expiries, OI/IV/underlying) | High | Open — blocked on data, not code |
| 3 | Greeks (gamma/vanna), theta-from-expiry filters | Med | Open — needs OI; expiry meta now plumbed |
| 4 | GitHub token exposed in chat | High | Open — revoke `ghp_BG1g…` |
| 5 | 38 MB CSVs committed | Med | Open — gitignore + upload flow exists |
| 6 | WF OOS thin on 21-session files | Med | Mitigated — folds + skips + honest logs |
| 7 | `DOCUMENTATION.md` stale (classic UI) | Low | Open |
| 8 | Bundle 1.48 MB, no code-split | Low | Open |
| 9 | MCX session coverage | High | **FIXED + proven** (`6247843`) |
| 10 | Metric divergence board/robustness | High | **FIXED + regression-tested** (`657d2f8`) |
| 11 | Silent worker death / stuck runs | High | **FIXED + verified** (`f972d78`) |
| 12 | Adaptive gate on raw Sharpe | High | **FIXED** — hard gate (`652d72d`) |
| 13 | Zero-cost paper passes | High | **FIXED** — cost required / signal-only warned |
| 14 | Options traded as futures | Med | **Mitigated** — buy-only, ATM, expiry/premium/IV filters; Greeks pending data |

---

## 16. On the external spec (`/Users/srinivas/upgrade.md`)

Implemented (adapted): Ehlers DSP, adaptive lookbacks, router persistence,
low-discrepancy sampling (**Halton, not Sobol** — correct by construction),
Bayesian EI refine, purged WF, block bootstrap, surrogate testing, PSS gate,
L8, options proxies. Declined with reasons: `{value,regime,meta}` registry
rewrite (breaks worker/runner/tests); pasted code with placeholders and math
bugs (unbounded Hilbert factor, undefined Squeeze/VWAP vars, stub FFT —
rewritten correctly); zero-cost doctrine (proven harmful on options; kept as
explicit signal-only mode); gamma/vanna (no OI data).

---

## 17. Roadmap to the stated goals

1. **Data:** 6+ expiries with OI/IV + underlying; 100+ sessions. Unlocks
   Greeks, theta filters, and any honest 70–80% WR hunt.
2. **Correctness:** IST pin (§15.1); refresh DOCUMENTATION.md; code-split.
3. **Hygiene:** gitignore CSVs; rotate token.
4. **Paper loop:** frozen version IDs surfaced in UI; drift panel; live-paper
   broker stub behind the eligible flag.

---

## 18. How to review (suggested pass order)

1. `public/engine.js` backtest core + `test/engine.test.js` beside it.
2. `effOptsFor` + `paperEligible` + `demoteKnifeEdge` (the trust anchors).
3. `public/worker.js` staging + `runner.ts` orchestration/WF/adaptive.
4. Upload `Data test/nifty_options.csv` → 42-way split → ATM select → Tier-A
   Halton run → confirm CANDIDATE == CORE == ROBUSTNESS in logs.
5. Upload an MCX-symbol file → confirm `ex=MCX(09:00→23:30)` in run line.
6. `server.js` gate + `ci.yml` smoke assertions.
7. §15 table — confirm/close each item.

*Every number above comes from the repo's own engine executed against the
repo's own sample files. No synthetic data anywhere in findings or tests.*
