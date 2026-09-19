# XBOST // Quant Terminal — Complete End-to-End Documentation

Institutional-grade algorithmic backtesting terminal for Indian markets
(Nifty / BankNifty / equities) on 1-minute OHLCV data, with a combinatorial
grid-search engine, dynamic exits, login-gated access, and CI/CD to Railway.

> Quant math reference: [`FORMULAS.md`](FORMULAS.md) (every indicator formula,
> signal rule, execution assumption, metric definition).
> Operator quick-start: [`README.md`](README.md).

---

## 1. What it does (60 seconds)

1. **Load** any 1-minute OHLCV CSV (auto-detected format, auto symbol).
2. **Configure** timeframes, indicators + parameter ranges, SL/TP grids, exit
   logic, intraday-vs-carry — all from the sidebar.
3. **Run** a Cartesian grid search (Web Worker, live-streamed) + hill-climb
   refinement until no improvement.
4. **Inspect** the ranked leaderboard, price/oscillator/equity charts, and the
   full trade log; click any row to load it; export CSVs.
5. **Validate** the engine against your live file (L1–L7 audit) and download a
   session log. Share via login accounts; deploy on Railway/Docker.

## 2. Repository map

```
XBOSTquant/
├── public/
│   ├── index.html      # terminal UI (Geist type, collapsible sidebar, tabs, charts)
│   ├── app.js          # dashboard controller (data, grid runs, rendering, exports)
│   ├── engine.js       # quant core: parse, resample, 22 indicators, backtest, grid
│   ├── worker.js       # grid-search + hill-climb refinement (Web Worker)
│   ├── auth.js         # login guard + user badge + logout (all protected pages)
│   ├── login.html      # sign-in page (public)
│   ├── users.html      # admin user management (admin only)
│   └── HDFCBANK_minute.csv  # optional local sample (git-ignored, 51 MB)
├── server.js           # Express session-auth gateway + user APIs + static host
├── test/engine.test.js # engine unit tests (npm test, 8 tests)
├── Dockerfile          # node:22-slim production image (no native builds)
├── railway.toml        # Railway: Dockerfile builder, start cmd, health check
├── .github/workflows/ci.yml  # pipeline: tests → live auth smoke → docker build
├── FORMULAS.md         # every formula, signal, assumption, metric
├── README.md           # run/deploy cheat sheet
└── package.json        # deps: express, express-session, bcryptjs (all pure JS)
```

No build step: frontend is static; backend is one Node file. No database
engine (users in `users.json`), no native modules.

## 3. Running it

| Mode | Command / steps |
|------|-----------------|
| Local dev | `npm install` → `ADMIN_USER=admin ADMIN_PASS='<secret>' SESSION_SECRET='<random>' npm start` → http://localhost:8901 |
| Docker | `docker build -t xbost .` → `docker run -p 8901:8901 -v $(pwd)/HDFCBANK_minute.csv:/app/public/HDFCBANK_minute.csv -e ADMIN_USER=… -e ADMIN_PASS=… -e SESSION_SECRET=… xbost` |
| Railway | New Project → Deploy from GitHub (`srinunaidu/XBOSTquant`) → set `ADMIN_USER/ADMIN_PASS/SESSION_SECRET` → volume at `/app/data` + `USERS_FILE=/app/data/users.json` → Generate Domain |

First boot creates the admin from env. Ports: `PORT` env (default 8901).
Health check path: `/login.html` (public by design).

## 4. Data ingestion (adapt to any file)

`parseCSV` sniffs each file — no fixed template required:

| Layout | Example | Detected as |
|--------|---------|-------------|
| Headered equity | `date,open,high,low,close,volume` | `header[…]+D` |
| Headerless futures | `BANKNIFTY_F1,20230102,09:16,O,H,L,C,VOL,OI` | `positional+SYM+D+T` |
| Combined stamp | `datetime,open,high,low,close,volume` | `header[…]+DT` |
| Epoch / splits / quotes | numeric stamps, extra columns | auto / ignored |

Rules: timestamps (epoch ms/s, ISO, `YYYY-MM-DD HH:MM:SS`, `YYYYMMDD`+`HH:MM`)
normalised to local ms; bare `HH:MM` without a date is rejected; bad rows
dropped; bars sorted ascending. Symbol = most frequent symbol-column value
with `_F1`/`_FUT` suffixes stripped (`BANKNIFTY_F1` → `BANKNIFTY`), else the
file-name token. Extra columns (expiry, OI, …) are ignored — OHLCV only.
The detected layout string is shown under the data panel (e.g.
`positional+SYM+D+T`). No synthetic data anywhere in analysis.

Session filter default 09:15–15:15; bars outside flatten intraday positions
(carry mode holds overnight). Date From/To inputs slice the loaded file.

## 5. Dashboard tour

**Sidebar** (collapsible via the ❮ chevron at its edge; state persists):
- ① Market data: CSV upload, Symbol (auto), Capital ₹, bundled-file button,
  From/To, live bar count + detected format.
- ② Timeframes: pill toggles 1/2/3/4/5/7/10/15m — 1m bars resampled on the fly
  (`O=first, H=max, L=min, C=last, V=sum` per bucket).
- ③ Objective: Sharpe / Sortino / WinRate / Trade-count / Drawdown + Top-N and
  combo cap (default 500 / 60,000) + live combo estimate.
- ④ Execution: direction (Long/Short/Both), **Entries** (trigger-only default
  vs always-in-market), session times, fallback SL/TP, trailing %, cost/trade,
  qty × lot, exit-logic checkboxes (Fixed / Breakeven+Trail / ATR Chandelier +
  BE-trigger/lock, ATR period/mult), session radio (Intraday / Carry / Both),
  SL×TP optimisation ranges, session-filter toggle.
- ⑤ Indicators A–Z in two groups (Classic + Institutional/Smart-Money), each
  with min/max/step ranges (all dynamic; nothing fixed).
- ⑥ Fill model: signal-bar close (default) or next-bar open.
- 🛠 Dev panel: live-data validation (L1–L7) + session-log download.

**Main workspace**: KPI glass cards (Net P&L, WR, Trades, PF, MaxDD,
Sharpe/Sortino) → Leaderboard tabs (**All results** · **Best per indicator** ·
**⚖ Compare exits**) → candlestick + overlays + signal markers → oscillator /
volume sub-charts → equity + underwater drawdown (MTM) → trade log (red edge =
exited inside the max-DD window; DD window times in the equity title) →
CSV exports (board + per-strategy trades with IST timestamps).

## 6. Indicator catalogue (30, all grid-searched, Tier A default)

Tiers (recomputable from Best-per-indicator; defaults: A on, B/C tick-to-run):
**A** — EMA, Bollinger, RSI, SuperTrend, VWAPBands, Squeeze, Stochastic, KAMA,
SqueezeBreak, VWAPRev. **B** — SMA, HMA, DEMA, MACD, Keltner, ADX, VWAP, CRSI,
CMO, Aroon, TrendRegime, POC. **C** — ChandeKroll, Fisher, CVD, FVG, Regime,
Chop, Cyber, VWMA.

Classic: EMA, SMA, HMA, DEMA, Bollinger, Keltner, RSI, MACD, VWAP, SuperTrend,
ADX, Stochastic, Chande-Kroll, POC. Proprietary-style (★): KAMA, Fisher
Transform, TTM Squeeze, Connors RSI. Smart-money: VWAP ±σ bands, CVD
divergence, FVG zones, Choppiness Regime gate. Pure price/volume (new):
Choppiness filter, Ehlers Cyber Cycle, VWMA, Chande MO, Aroon.
Combinatorial presets (★P): SqueezeBreak (squeeze + volume spike + CK stops),
TrendRegime (chop gate + SuperTrend + MACD hist), VWAPRev (VWAP fade + CMO).
Full maths in FORMULAS.md §§3–4.

## 7. Execution model (essentials; proofs in FORMULAS.md §5)

- Entries at signal-bar close (or next open); resting stops fill intrabar at
  stop levels; same-bar SL+TP touch resolves to SL (conservative).
- Exits: fixed SL/TP, breakeven lock (default 1R trigger), ATR chandelier,
  session square-off, signal flip/flat, configurable trailing (profit-armed).
- Trigger-only entries (default): fresh signal edges only, never on an exit
  bar — no flip-chains. Always-in-market available as an option.
- Costs deducted per round trip; `qty × lotSize` sizing; ruin guard (no new
  entries once equity ≤ 0); final bar always closes.

## 8. Metrics glossary

Net P&L, Win Rate %, Trades (+/day), Profit Factor, Max DD % (MTM curve with
peak→trough attribution), Sharpe / Sortino (daily strategy returns over
*starting* capital — immune to negative-equity artefacts), Expectancy,
final capital, gross ±. Board also shows SL %, TP %, Exit mode, Session.

## 9. Search engine (+ regimes, ML, walk-forward)

- Regime routing (toggle, default ON, day granularity default): one label per
  session from prior-session data; entries only on in-regime bars per the
  router table (rules or ML-predicted source); exits unchanged. Per-regime
  split (trades/WR/net) shown for the selected strategy.
- ML regime classifier: softmax on 10 causal features, trained in-sample,
  applied everywhere; per-timeframe train accuracy in the session log.
- Walk-forward (optional): grid on in-sample slice, top-200 verified on the
  untouched tail → `oosNet/oosWR/survived` columns + export.


- **Stage 1**: exhaustive Cartesian product
  timeframes × params × SL × TP × exit-mode (fixed/breakeven/ATR/CK)
  × day/carry (axis cap 25, grid cap configurable). Runs in a Web Worker (main-thread fallback), streaming the
  leaderboard live with per-batch current-config readout.
- **Stage 2**: hill-climb refinement of the top-20 (every param ±1 UI step,
  incl. SL/TP, exit/carry lineage preserved) until no improvement (max 4
  passes, ≤600 candidates/pass). Refined rows carry 🔁.
- **Ranking** by the chosen objective (ties → Net P&L); zero-trade rows always
  sort below traded rows. Compare tab pits exit-profile champions against each
  other with overlaid equity curves.

## 10. Validation & logs

🛠 **Debug & Validate** audits the *loaded live file*: L1 integrity, L2
resample conservation, L3 warmup quarantine, L4 cost/equity identities +
trade repricing (+next-open fills when enabled), L5 BE/ATR legs firing
(SKIP on thin files), L6 ruin invariant + bounded overshoot + finite metrics,
L7 session/OI/fill status. Every validation and grid summary (with top-3) is
timestamped into a downloadable session log (`.txt`).

## 11. Auth, users, API

- Session cookies (httpOnly, 12h), bcrypt hashes, login throttle (10 fails /
  5 min / IP), roles `admin`/`user`, active flags, self-demotion/self-disable
  blocked. Public: `/login.html`, `/api/login`. Everything else needs a session
  (`/` → redirect, assets → 401); `server.js`/`users.json` are never servable.
- APIs: `POST /api/login|/logout`, `GET /api/me`,
  `GET /api/users`, `POST /api/users {username(3–32), password(8+), role}`,
  `PATCH /api/users/:id {active,password,role}` (admin-only).
- Users page (`/users.html`, admin): create, enable/disable, reset password.

## 12. Pipeline & deploys

`.github/workflows/ci.yml` on push/PR to `main`: `npm ci` → `npm test`
(8 engine tests) → live auth smoke (guard 302/401 → login → terminal 200 →
user CRUD → disable → logout) → `docker build`. Railway consumes
`railway.toml` (Dockerfile builder, `node server.js`, `/login.html` health
check) and auto-deploys pushes once the GitHub App has repo access
(`github.com/apps/railway-app` → XBOSTquant → Refresh repos in Railway).

## 13. Troubleshooting

| Symptom | Cause → fix |
|---------|-------------|
| Old UI / HDFC defaults live | Railway built a stale snapshot: redeploy **latest** `main` (never ⋮-Redeploy an old entry); check repo has zero webhooks → reconnect GitHub App |
| `ERR_NAME_NOT_RESOLVED` on LAN URL | Viewer-side VPN on → turn it off; same Wi-Fi required |
| Board all-negative | Usually cost drag: same strategy at cost 5 vs 20 flips sign (proven). Lower cost, higher TFs, fewer trades/day |
| DD with no single culprit trade | Normal: DD is cumulative + intra-trade heat; use red-edged rows + DD window times |
| Zero-trade rows on top | Impossible by design (demoted); if seen, hard-refresh (stale JS) |
| OI-ish data | OI columns ignored; only OHLCV legs exist |
| `users.db` / secrets in repo | Both user-store patterns git-ignored; never commit `users.*`, `.env` |

## 14. Git history (highlights)

`Dynamic exits` → `Smart-money suite + fill modes` → `Zero-trade demotion` →
`OI removal (OHLCV-only)` → `Login + users + CI` → `Railway config` →
`JSON user store` → `Neutral defaults + visual overhaul` → `Multi-format
ingest` → `Trigger entries + MTM drawdown` (+ validation hardening).
