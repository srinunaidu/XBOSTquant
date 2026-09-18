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
