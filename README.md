# XBOST — Institutional Algo-Backtesting Terminal

Grid-search backtester for Indian markets (Nifty/BankNifty/equities) on 1-minute
OHLCV. Login-gated via the bundled Node server. Quant formulas: `FORMULAS.md`.

## Run locally

```bash
npm install
ADMIN_USER=admin ADMIN_PASS='<strong-secret>' SESSION_SECRET='<random>' npm start
# open http://localhost:8901 → login → terminal
```

First boot creates the admin user from `ADMIN_USER`/`ADMIN_PASS`.
Data: place your 1-min CSV at `public/HDFCBANK_minute.csv`
(`date,open,high,low,close,volume`) or upload it in the UI.

## Manage users

Log in as admin → **👥 Users** (header) or open `/users.html`:
create/disable accounts, reset passwords. API: `POST /api/users`,
`PATCH /api/users/:id`, `GET /api/users` (all admin-only).

## Run with Docker

```bash
docker build -t xbost .
docker run -p 8901:8901 -v $(pwd)/HDFCBANK_minute.csv:/app/public/HDFCBANK_minute.csv \
  -e ADMIN_USER=admin -e ADMIN_PASS='<strong-secret>' -e SESSION_SECRET='<random>' xbost
```

## Pipeline

`.github/workflows/ci.yml` runs on push/PR: engine unit tests (`npm test`),
live auth smoke (login guard → login → terminal → user CRUD), then a Docker
build check.

## Deploy on Railway (public URL for others)

1. Railway → **New Project → Deploy from GitHub repo** → pick `XBOSTquant`.
   (`railway.toml` in the repo sets build + start + health check.)
2. **Variables** tab — add:
   - `ADMIN_USER=admin`
   - `ADMIN_PASS=<strong-secret>` (first boot creates this admin)
   - `SESSION_SECRET=<long-random-string>` (keeps logins alive across restarts)
3. **Volumes** (keeps accounts after redeploys — without this `users.db`
   resets): add volume, mount path `/app/data`, plus variable
   `DB_PATH=/app/data/users.db`.
4. **Settings → Networking → Generate Domain** → share that URL.
   Your friend opens it, you create their account in 👥 Users, done.
5. Data: the 51MB CSV is not in git — upload it in the sidebar each session
   (parsed in-browser), or place it at `public/HDFCBANK_minute.csv`.
