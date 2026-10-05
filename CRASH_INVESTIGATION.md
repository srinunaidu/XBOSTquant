# Crash Investigation & Fix Report — 5 Oct 2026

End-to-end record of three production incidents diagnosed and fixed in one
session: (1) post-login `Cannot GET /login.html`, (2) Railway crash-loop on
`./buyonly_api`, (3) Buy Only engine rejecting the wide-format sample file.
All fixes are on `origin/main`. Verification was by reproduction in every
case, not by code review alone.

---

## 1. Post-login reload 404 (`Cannot GET /login.html`)

### Symptom
After logging in, any page reload or bookmarked URL showed a stark
`Cannot GET /login.html` page. Fresh (logged-out) visits worked, which made
the failure look intermittent.

### Discovery
- `server.js` boots fine locally; web typecheck, tests, and `vite build` all
  pass, so the crash was not a build or syntax problem.
- Reproduced in a real browser: unauthenticated `GET /login.html` → 200 app
  shell; **authenticated `GET /login.html` → 404**.
- Root cause in the Express gate (`server.js`): the session check ran
  *before* the SPA-shell serve. `web/dist/` contains only `index.html` (no
  `login.html`/`users.html` files), so an authenticated request fell through
  to `express.static` and 404'd. The client router (hash-based) never got a
  chance to boot.

### Fix — commit `ae39976`
- `server.js`: serve the SPA shell for `/`, `/index.html`, `/login.html`,
  `/users.html` **before** the session check in dist (React) mode. Anonymous
  users still get the shell with the Login route; engine/worker/data/APIs
  stay session-guarded; the legacy classic-terminal flow is untouched. Kept
  the `{root: PUBLIC_DIR}` `sendFile` form (a bare absolute path fails with
  `NotFound` in some environments).
- `.github/workflows/ci.yml`: `auth-smoke` now asserts authenticated
  `/login.html` and `/users.html` serve the shell — the exact hole this bug
  slipped through.

### Verification
- curl matrix, authenticated: `/`, `/index.html`, `/login.html`, `/users.html`,
  `/engine.js`, `/worker.js` → all 200, shell contains `id="root"`.
- curl matrix, unauthenticated: shell pages → 200; `/engine.js`, `/api/me` →
  401 (guard intact).
- Browser: login → reload → authenticated deep-route (`#/discovery`) reload,
  zero console errors; full in-browser discovery run completed (122-row
  board, `NO_EDGE_FOUND_WITHIN_SEARCH_BUDGET`).

### Side finding (same session)
- `test/discovery.test.js` looked hung in CI-length runs: it was volume, not
  a hang (~30 s full engine runs × many; suite takes ~9 min).
- One real failure inside it: empty-candidate crash in the new effectiveN-BH
  block (`order[0]` indexed with zero candidates, `minEvents: 1e9` case).
  Fixed and confirmed; full JS suite went **147/147**, Python suite
  **60 passed**, web tests green.
- The pre-existing uncommitted working tree turned out to be **stale**:
  `origin/main` already carried newer versions of the same research. Merging
  would have deleted 10 new Python modules, so the local line was preserved
  untouched on branch `research-trials-aware` (superseded — safe to delete)
  and only the crash fix was applied to current `main`.

---

## 2. Railway crash-loop: `Cannot find module './buyonly_api'`

### Symptom
Railway deploy crash-looped immediately after start. Deploy log (attached to
the session as `logs.1791175481159.log`) repeated:

```
Error: Cannot find module './buyonly_api'
Require stack: - /app/server.js        (server.js:123)
```

### Discovery
- `server.js:123` does `require('./buyonly_api')(app)`, but the Dockerfile
  runtime stage copied only `server.js` + `public/` + `web/dist` into the
  image. The module exists in the repo, in local dev, and in CI (full
  checkout), so the crash was **Docker-image-only** — invisible everywhere
  except Railway.
- Reproduced locally by booting the exact runtime file set → identical
  `MODULE_NOT_FOUND`, then boot success once the files were added.

### Fix — commit `9c0037d`
- `Dockerfile`: `COPY server.js buyonly_api.js buyonly_fake.js ./`
- Confirmed the Buy Only endpoint degrades gracefully when Python is absent
  (`child.on('error')` → SSE error message, no process crash), so the boot
  fix alone unblocks the site.

### Follow-up chosen in-session — commit `a6b5c8e`
- `node:22-slim` ships no Python, and the engine package was never copied, so
  Buy Only runs would still fail per-request. Added to the runtime image:
  `python3` + `pip install pandas numpy` and `COPY xbost_option_discovery/`.
- Verified the CLI runs from the image file layout
  (`PYTHONPATH=/app python3 -m xbost_option_discovery.run_buyonly --help`
  plus a full sample run emitting a valid `bundle.json`).
- Caveat: no local Docker daemon here, so the real image-build proof is CI's
  `docker` job plus the Railway redeploy itself.

---

## 3. Buy Only engine rejects the wide-format sample file

### Symptom
Running the Buy Only tab on `banknifty_opt_band_1m.csv` failed with:

```
[stderr] KeyError: 'timestamp'
  File "/app/xbost_option_discovery/run_buyonly.py", line 48, in load_quotes
    q["timestamp"] = pd.to_datetime(q["timestamp"])
ERROR: engine exited with code 1
```

### Discovery
- The file is **wide-format** chain data:
  `ts,ist,expiry,54700CE_o,…,54900PE_v` (3367 bars, 6 contracts, 3 strikes).
- `run_buyonly.load_quotes` assumed **long** format (one row per contract
  bar) with its own hand-rolled rename map — no `ts` alias, no wide handling.
- Second bug behind the first: `ts` holds integer **epoch seconds**, which
  `pd.to_datetime` reads as *nanoseconds* → every bar dated 1970, silently
  corrupting sessions, moneyness, and day logic.

### Fix — commit `65ac0ac`
- `run_buyonly.load_quotes` now delegates to the canonical
  `ingestion.load_dataset`, which accepts long **and** wide (contract-token
  parsing, `ts`/`ist` aliases, `expiry` column).
- `ingestion._to_datetime`: integer timestamp columns get magnitude-inferred
  epoch units (s / ms / ns), tz dropped so they stay comparable with naive
  string columns. Applied in both `load_long` and `load_wide`.

### Verification
- Full CLI run on the user's file, RC=0, all artifacts written
  (`ledger.csv`, `summary.json`, `report.md`, `buyonly-bundle.json`, …):
  6 contracts, 17 sessions (2026-09-08 → 2026-10-01), 62 signals → 4 trades,
  verdict `NO_VALIDATED_EDGE` (25% win rate, PF 0.04).
- Data notes (not bugs): no OI field → `OI_VELOCITY` correctly reports
  `NOT_AVAILABLE`; no futures upload → ATM via put-call parity proxy.
- Python suite after the change: **128 passed, 7 skipped** (pre-existing
  documented skips).

---

## Commits (all on `origin/main`)

| Commit | Change |
|---|---|
| `ae39976` | SPA shell served before session check (reload-404 fix) + CI cover |
| `9c0037d` | Dockerfile copies `buyonly_api.js` + `buyonly_fake.js` (Railway boot fix) |
| `a6b5c8e` | Python + pandas/numpy + engine package in Docker image (Buy Only runs) |
| `65ac0ac` | Buy Only wide-format ingestion + epoch-second timestamps |

## Remaining / watch items
- Confirm Railway is green after redeploy (log showed crash-loop + 10
  restart retries; healthcheck is `GET /login.html` → 200).
- CI `docker` job is the proof for the image changes (no local Docker here).
- Branch `research-trials-aware` holds the superseded stale working tree;
  delete after confirming nothing of value remains.
- The Buy Only verdict on the sample file (`NO_VALIDATED_EDGE`, 4 trades) is
  a data statement, not an engine problem — more sessions/data needed before
  any paper consideration.
