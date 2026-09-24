# XBOST — Full Project Review

**Date:** 2026-09-24 · **HEAD:** `1311654` · **Branch:** `main` (in sync with `origin/main`)
**Reviewer:** Muse Spark (working session with repo owner)
**Purpose:** single detailed reference for a human/technical review of the entire
XBOST codebase — what exists, how it works, what was verified by execution,
what is broken or risky, and what remains to reach the stated goals
(70–80% WR strategies, validated Options Lab, paper-trading gate).

Related docs (older, partially stale): `README.md` (run/deploy cheat sheet),
`DOCUMENTATION.md` (classic-terminal-era end-to-end docs), `FORMULAS.md`
(formula reference, mirrors `engine.js`).

---

## 1. Executive summary

XBOST is a login-gated, single-server **algorithmic backtesting terminal for
Indian markets** (Nifty / BankNifty / equities) on 1-minute OHLCV. The core
loop is:

```
CSV upload → parse/split → resample → Cartesian grid search (Web Worker)
  → hill-climb refinement → staged robustness scoring (0–10)
  → walk-forward OOS check → leaderboard → charts/trade log/stress lab
  → CSV + session-log export
```

Design philosophy (enforced in code, not just docs): **robustness over peak
Sharpe** — a candidate must survive parameter stability, exit independence,
regime/time/entry/input perturbations, order randomization, concentration,
best-trade removal, bootstrap CI, deflated Sharpe, leakage audit and sample
gates before it is paper-trade eligible.

**State at HEAD:**
- React terminal builds clean; **18/18 engine unit tests + 3/3 web tests pass**;
  `tsc --noEmit` clean; CI (tests → auth smoke → docker build) defined.
- Landing page with **Futures Terminal / Options Lab** tiles (new, visually
  verified headless).
- Futures pipeline is complete end-to-end. **Options Lab is a shell**: routing,
  upload, and per-contract split exist, but no buy-only enforcement, no ATM
  auto-select, no expiry/premium logic yet — the same futures engine runs
  whatever is enabled.
- Deployed on Railway (auto-deploy from `main`); local server on `:8901`.

---

## 2. Repository map (accurate at HEAD)

```
XBOSTquant/
├── server.js                 # Express session-auth gateway + user APIs + static host (168 lines)
├── users.json                # JSON user store (no DB)
├── package.json              # root: express, express-session, bcryptjs; workspaces:[web]
├── public/
│   ├── engine.js             # QUANT CORE: parse, 30 indicators, signals, backtest, grid, regimes, ML (1519)
│   ├── robustness.js         # staged 0–10 robustness engine, 20 evidences (305)
│   ├── worker.js             # grid-search + hill-climb Web Worker (217)
│   ├── app.js / index.html / login.html / users.html / auth.js   # LEGACY classic terminal (fallback)
│   ├── HDFCBANK_minute.csv   # 51 MB futures sample (committed)
│   ├── nifty_options.csv     # 17 MB, 42 contracts (committed)
│   └── banknifty_options.csv # 21 MB, 42 contracts (committed)
├── "Data test"/              # canonical samples (NOT committed except copies above)
│   ├── nifty_futures_1m.csv / banknifty_futures_1m.csv   # small futures samples
│   └── nifty_options.csv / banknifty_options.csv         # options samples (42 contracts each)
├── test/engine.test.js       # 18 unit tests (node --test)
├── web/                      # React terminal (Vite + TS + Tailwind + AG Grid + lightweight-charts)
│   ├── scripts/sync-engine.js# copies public/{engine,worker,robustness}.js into build (prebuild)
│   ├── src/App.tsx           # hash routing: '' → Home, futures/options → terminal
│   ├── src/pages/            # Home.tsx (2 tiles + upload), Login.tsx, Users.tsx
│   ├── src/components/       # Header, Sidebar, MainView, KpiStrip, Leaderboard,
│   │                         # RegimeSplit, RunSummary, StressPanel, TopFiveReview,
│   │                         # TradeLog, ChartPanels (11 files)
│   └── src/lib/              # store, runner, data, engine facade, config, report,
│                             # stress, validate, export, format, api, router, robustness (14 files)
├── Dockerfile / railway.toml / .github/workflows/ci.yml
├── README.md / DOCUMENTATION.md / FORMULAS.md / PROJECT_REVIEW.md (this file)
```

**Counts:** engine 1519 + robustness 305 + worker 217 + server 168 +
web lib ~1500 + web components ~1450 + tests. No native deps, no DB engine.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Quant core | Vanilla JS, `Float64Array`/`Int8Array`, zero DOM | Runs identically in browser, Worker, and Node (tests) |
| Frontend | React 19, Vite 7, TypeScript 5.8, Tailwind 4, Zustand 5 | SPA served from `web/dist` when built |
| Charts/grid | lightweight-charts 4, AG Grid 33 | |
| Tests | `node --test` (engine), Vitest (web utils) | |
| Backend | Express 5, express-session, bcryptjs | Pure-JS, no native builds |
| Deploy | Dockerfile (`node:22-slim`) → Railway, `railway.toml` health check | Auto-deploy from `main` |
| CI | GitHub Actions: tests → typecheck → web tests → web build → auth smoke → docker build | |

Engine sharing is explicit and safe: `web/scripts/sync-engine.js` copies the
three `public/*.js` files at prebuild, so browser and Node always test the
same code.

---

## 4. Data layer

### 4.1 Formats accepted (`parseCSV` sniffing, `public/engine.js:35`)
- Headered equity: `date,open,high,low,close,volume` (case/casing variants,
  `datetime`, `settle/ltp`, `vol/qty`, `symbol/scrip` synonyms).
- Headerless positional futures dumps (`SYMBOL,YYYYMMDD,HH:MM,O,H,L,C,VOL,OI`).
- **Options multi-contract:** `date,symbol,strike,otype,expiry,open,high,low,close,volume`.
- Timestamps: epoch ms/s, ISO, `YYYY-MM-DD HH:MM:SS`, `YYYYMMDD`+`HH:MM`.
  Bad rows dropped, bars sorted ascending. Layout string shown in UI.

### 4.2 Multi-contract split (`parseCSVAll`, `engine.js:152`) — verified by execution
Uploading `nifty_options.csv` yields **42 pure per-contract datasets**
(largest first; only the largest enabled by default). Verified output:

```
0 NIFTY29SEP2623500PE 7882 bars … 41 NIFTY29SEP2622950CE 332 bars
```

`parseCSV` keeps only the largest contract and flags the rest. Rationale
(documented in FORMULAS.md): blending strikes fabricates win rate; the loader
refuses to do it silently. **18th unit test covers this.**

### 4.3 Sample data inventory
| File | Bars | Span | Notes |
|---|---|---|---|
| `public/HDFCBANK_minute.csv` | ~1.03M 1m | 2015–2026 | 51 MB; futures/equity |
| `public/nifty_options.csv` | 42 × ~0.3–7.9k | 2026-08-20 → 09-18 | 17 MB; 29SEP2026 expiry |
| `public/banknifty_options.csv` | 42 × ~0.3–7.9k | same window | 21 MB |
| `Data test/*_futures_1m.csv` | small | — | canonical small futures samples |

### 4.4 ⚠️ Timezone finding (reviewer attention required)
`buildSessionMask` (`engine.js:1153`), `buildWindowMask` (`:1163`), and the
session heatmap (`web/src/lib/stress.ts:78`) bucket bars with
`Date#getHours()/getMinutes()` — i.e. **viewer-local time** — while the
session windows are hardcoded IST (`09:15–15:30` → buckets 555–930). The CSV
stamps parse to `03:45Z` (= 09:15 IST). Consequences:
- Correct for viewers in IST (verified on this machine).
- Wrong for any viewer outside IST (session filter silently zeroes bars;
  heatmap misattributes). The engine runs client-side, so Railway's UTC
  clock is irrelevant — but a reviewer travelling, or a VPS-hosted headless
  run, gets different results from the same file.
- **Recommendation:** parse stamps as IST wall-clock explicitly (fixed
  `+05:30` offset, no DST in India) instead of relying on host TZ.

---

## 5. Quant engine (`public/engine.js`)

### 5.1 Indicators (30, `SCHEMA` at `engine.js:1376`)
Trend: EMA/SMA/HMA/DEMA · Bands/channels: Bollinger, Keltner, VWAPBands ·
Momentum: RSI, MACD, Stochastic, CMO, CRSI, Fisher · Volatility/structure:
SuperTrend, ATR, ADX, ChandeKroll, Squeeze, Aroon, Choppiness/Regime/Chop gates,
CyberCycle · Volume/order-flow: VWAP, VWMA, POC (24-bin profile), CVD
divergence · Smart-money: FVG zones · Combos: **SqueezeBreak** (squeeze +
volume + CK stops), **TrendRegime** (chop + ST + MACD), **VWAPRev** (VWAP fade
+ CMO). All `NaN` during warmup; **no signal emitted from warmup bars**
(enforced + unit-tested, L3 audit).

### 5.2 Signal → execution semantics (`backtest`, `engine.js:1187`)
- `buildSignals` outputs `Int8Array` per bar: `1` long / `-1` short / `0` flat
  (indicator-specific rules in `engine.js:605–790`).
- Fill models: signal-bar **close** (default, causal) or **next-bar open**
  (stricter; UI default is `next`). Resting SL/TP/trailing always fill
  intrabar at stop levels; same-bar SL+TP collision resolves to **SL**
  (unit-tested).
- Exits: `fixed` SL/TP · `breakeven` (+trigger/lock) · `atr` Chandelier ·
  `ck` Chande-Kroll structural (bridged from preset params via
  `exitOptsFromParams`). Plus `trailPct`.
- Session: intraday mask flattens outside hours; `carry` holds overnight;
  trade-window buckets ANDed. Trigger-only vs always-in-market entries.
- Guards: cash-flow identity (throws on violation), ruin halt (no post-ruin
  entries), all unit-tested.
- Costs: per-trade flat ₹ (`cost`), `qty × lotSize` sizing.
- Metrics per run: netPnL, winRate, totalTrades, profitFactor, maxDD (MTM
  equity, peak/trough attributed), Sharpe/Sortino (**daily returns on initial
  capital**, annualised √252), expectancy, trades/day, days, gross P/L,
  costs, MAE/MFE/lat per trade.

### 5.3 Grid + refinement
`buildGrid` (Cartesian over indicator params × SL × TP × exits × carry),
`rankResults` (5 objectives: sharpe/sortino/winrate/trades/drawdown),
hill-climb `paramNeighbors` until no improvement (≤4 passes over top-20,
≤600 candidates). Objective gate `isGood` in `runner.ts:34` (Sharpe ≥ 1 +
2 of WR/PF/DD).

---

## 6. Regime routing + ML (`engine.js:798–1086`)

- Rule regimes per bar: **T+ / T− / RH / RL** (trend±, range hi/lo-vol);
  per-indicator routing table (`ROUTER`).
- **Day granularity (default):** sessions segmented (`daySegments`), featurised
  (`dayFeatures`),   rule-labelled (`dayRuleLabels`), then either rule labels or
  **softmax day-ML** (`trainDayML`) with confidence gate (default
  60%): low-confidence days run **unrouted but counted** (never silent).
- Bar-level ML fallback (`trainRegimeML`, 70/30 split, 200 iters,
  train-acc logged).
- ML needs **≥20 sessions**; short files fall back to rules with a log notice.

---

## 7. Grid-search pipeline (`web/src/lib/runner.ts`, `public/worker.js`)

1. Multi-symbol: same grid × each enabled symbol; merged leaderboard with
   Symbol column; best-per-symbol surfaced.
2. Worker-first (25-row progress batches, live top-N, errCount, current-combo
   readout), main-thread fallback, stop support, 30-min timeout.
3. Refine loop, then **Top-25 robustness** in-worker (`robustnessFor`), capped
   6.8 until the full evidence suite is present; Top-25 re-ranked robustness-first.
4. `wfVerify`: top-200 re-run on untouched OOS tail (default 70/30 split);
   rows gain `oosNet/oosWR/oosN/survived`.
5. Agent-readable `RUN SUMMARY` block + machine logs (`report.ts`:
   `formatCandidateHeader`, `formatCoreSignal`, `formatIsOos`).
6. **Adaptive tiers:** if Tier-A best fails `isGood`, auto-enable B, then C,
   and re-run (toggleable).

---

## 8. Robustness engine (`public/robustness.js`, 0–10)

20 evidences: param stability (density/median/p5/worst Sharpe) ·
exit independence · signal purity (indicator-only vs full) · direction ·
regime (4) · time (4 windows) · entry/input/jitter perturbations ·
trade-order MC · concentration (top-1/5/10%) · best-trade removal (1/3/5/10) ·
regime removal · cross-market transfer · clustering · distribution
(skew/kurt) · bootstrap CI · **deflated Sharpe** · multiple-testing penalty
(`log10(combos)/5`) · sample gate (<30/100 → cap 6) · leakage audit.
Staged cost control: cheap Top-500 → medium Top-100 → full Top-25 → Top-10
paper gate. `parameters_locked: true, reoptimized: false` stamped on every
evidence (anti-reoptimization proof). Classification: ≥9.5 candidate,
≥8 very robust, ≥6.5 robust, ≥4.5 interesting, ≥2.5 weak, else fragile.

**Paper gate** (all required): lookahead audit PASS · OOS survived ·
score ≥ threshold · n ≥ 200 · no cap violation · no silent re-opt. Frozen
`STRATEGY_VERSION_ID` + drift-monitor hooks.

---

## 9. Frontend review (`web/src`)

Routes (`App.tsx`): `#/` → **Home** (new) · `#/futures|#/options` → terminal
(`instrumentMode` in store) · `#/users` admin · `#/login`.
Components: `Header` (badges, exports, run/stop, Home back-link, alerts) ·
`Sidebar` (data, timeframes, objective+WF, execution, regime, 30 indicators,
fill model, dev/validation panel) · `MainView` (KPI strip, summary, top-5
review, leaderboard, regime split, stress lab, price/osc/equity/DD charts,
trade log) · `Home` (hero, inline upload, FUT/OPT chips, 2 tiles).
Lib: `store` (Zustand single state) · `data` (upload→`parseCSVAll`, date
filter) · `stress` (seeded MC-DD, streak probs, IST heatmap, MAE/MFE) ·
`validate` (L1–L7 live audit + ML checks) · `export` (board/trades CSVs with
IST stamps, regime columns) · `report` (machine logs).

**Home page** (new at HEAD, headless-screenshot verified): header present,
centered column layout, inline uploader, FUT/OPT dataset chips (capped 9 +
`+N more`), tiles always enterable with READY/NO-DATA badges and live counts.

---

## 10. Server / auth / security (`server.js`)

Express session gateway: public `/login.html`, `/api/login`; everything else
gated (SPA shell served 200 with client-side routing — no redirect loops
through proxies). JSON user store + admin bootstrap from env; login throttle
(10 fails/5 min/IP); admin-only user CRUD with self-demote/deactivate guards.
Static serving prefers `web/dist`, falls back to legacy `public/`.

**Findings:**
- Dev defaults (`changeme`, `xbost-dev-secret-change-me`) warn loudly — fine
  for local, must be env-set on Railway (documented).
- ⚠️ A live GitHub token was pasted in chat during this session — **revoke it**
  (GitHub → Settings → Developer settings → Tokens) and mint a scoped
  replacement. It is not stored in the repo (push used an inline URL; remote
  config is clean), but it lives in shell/chat history.
- No rate limiting beyond login throttle; no CSRF tokens (same-origin SPA +
  `SameSite=Lax` cookies mitigate); session cookies `HttpOnly`.

---

## 11. Tests & CI (all passing at HEAD)

- `npm test` — **18/18** engine tests: parse sort, resample exactness, cost
  identity, slope ride, gap-through-stop, trigger-only entries, MTM/DD
  attribution, grid/rank/refine helpers, next-open fills, SL/TP collision,
  ruin halt, indicator warmup, regime router + masks, deterministic ML,
  validate-layer ML checks, fallback-day counting, multi-contract split.
- `web`: 3/3 Vitest + `tsc --noEmit` clean + `vite build` green (~1.43 MB JS).
- CI (`ci.yml`): install → engine tests → web typecheck/tests/build →
  **live auth smoke** (shell 200, zero redirects, bundle public while
  engine/worker/data stay 401) → user CRUD → docker build.

---

## 12. Deployment

Railway auto-deploys `main` (Dockerfile build, `railway.toml` start +
healthcheck). Required vars: `ADMIN_USER`, `ADMIN_PASS`, `SESSION_SECRET`;
persistence needs volume `/app/data` + `USERS_FILE=/app/data/users.json`
(without it `users.json` resets on redeploy). Local: `:8901`. Production URL
(from screenshot): `xbostproduction.up.railway.app`.

---

## 13. Empirical findings (executed this session, Node + headless browser)

1. **Options parse:** 42 contracts/file split correctly, largest-first.
2. **Cost dominates options:** with `cost=20/trade` every strategy prints
   ~0% WR on options — a 3% TP on a ₹65 premium is ~₹2 gross vs ₹20 cost.
   Realistic options costing (`cost≈2`, `lotSize=75` Nifty) is required;
   store default `cost=0` flatters futures and must be set deliberately.
3. **Direction trap:** Long-only + a signal that flips short produces
   `SESSION/FLAT` exits (mask/forcing logic, `engine.js:1199–1205`) — correct
   but confusing in logs; `Both` is the honest default for discovery.
4. **Trend trap on PUT conducting sample:** the front PUT ran 72→228; pure
   trend signals stay long and print 100%/1-trade artefacts with no SL/TP,
   while tight trailing stops chop the trend into ~40–60% WR losers.
5. **Closest to 70% on sample:** Bollinger(22, 2.5), no SL/TP, Both, carry —
   **69.6% WR, n=23, PF 1.15** on `NIFTY29SEP2623500PE` 5m. With SL/TP grid,
   best ≈ 65–67% WR at n≈600–700 (negative expectancy after costs).
   Conclusion: the 2-month, 21-session options sample cannot honestly yield
   70–80% WR yet — more sessions/expiries are needed, not looser thresholds.
6. **Futures (HDFCBANK, recent 200k bars):** simple single-indicator sweeps
   score poorly — expected; the full pipeline (regime routing + SL/TP grid +
   robustness) is what separates signal from noise.
7. **Home page:** before fix — dead-end tiles, broken flex layout (screenshot
   in session); after fix — verified via 4 headless screenshots (empty home,
   loaded home with 42 OPT chips + READY badge, options terminal with
   back-link and carried-over datasets).

---

## 14. Gaps, risks, and review asks

| # | Item | Severity | Detail |
|---|---|---|---|
| 1 | Timezone-dependent session/heatmap logic (§4.4) | **High** | Pin IST explicitly; add a unit test with `TZ=UTC` |
| 2 | Options Lab incomplete | **High** | No buy-only enforcement, ATM select, expiry-day exclude, premium floor, ATM±1 bake-off; `instrumentMode` doesn't filter datasets per terminal |
| 3 | 38 MB of CSVs committed (`public/*options*.csv` + 51 MB HDFCBANK) | **Med** | Repo bloat; move to `.gitignore` + document upload flow (already the runtime path) |
| 4 | GitHub token exposed in chat | **High** | Revoke `ghp_BG1g…` immediately |
| 5 | ML needs ≥20 sessions; options sample has 21 | **Med** | Borderline; log is honest (fallback counted) but more expiries needed |
| 6 | WF OOS logging regressed to `—/—` in recent runs | **Med** | Verify `wfOn` path emits `oosNet/survived` after latest commits |
| 7 | `App.tsx` sets store during render | **Low** | Move `instrumentMode` set into hashchange effect |
| 8 | `DOCUMENTATION.md` stale (classic UI, "22 indicators", "8 tests") | **Low** | Refresh or mark superseded by this file |
| 9 | Bundle 1.43 MB, no code-splitting | **Low** | Lazy-load charts/AG Grid on terminal routes |
| 10 | Legacy `public/app.js` terminal untested by CI smoke beyond shell | **Low** | Decide: keep fallback or remove |

---

## 15. Roadmap to the stated goals

1. **Options Lab build-out:** buy-only (`LONG CE/PE`) direction lock;
   per-day ATM detection from underlying proxy; auto-select ATM ±1 bake-off;
   expiry-day exclusion toggle; premium floor filter; contract-aware lot sizes.
2. **Data:** ≥6 expiries / 100+ sessions of options; rail the 70–80% WR hunt
   on that, with WF + robustness gates unchanged (no threshold gaming).
3. **Correctness:** IST pin (§14.1); futures/options dataset scoping per
   terminal; cost/lot presets per instrument.
4. **Paper gate completion:** frozen version IDs in UI, drift alerts wired to
   a visible panel, OOS log lines re-verified on Railway.
5. **Hygiene:** gitignore CSVs, rotate token, refresh DOCUMENTATION.md,
   code-split bundle.

---

## 16. How to review (suggested pass order)

1. `public/engine.js:1187–1360` (backtest core + identities) with
   `test/engine.test.js` open beside it.
2. `public/robustness.js:224–302` (scoring, caps, gate) — check weights vs
   philosophy.
3. `public/worker.js` staging + `web/src/lib/runner.ts:350–470` (orchestration,
   WF, summary).
4. `web/src/lib/validate.ts` L1–L7 against your own CSV via the dev panel.
5. Upload `Data test/nifty_options.csv` → confirm 42-way split → run Tier-A
   grid → confirm logs show `[ROBUSTNESS START]…[FINAL]`.
6. `server.js:141–163` gate logic + `ci.yml` smoke assertions.
7. This file's §14 table — confirm/close each item.

*No synthetic data was used in any finding above; every number comes from the
repo's own engine executed against the repo's own sample files.*
