# Connect — total solution
Node.js + Express + file NoSQL (`data.json`). Serves API + frontend statically.
- `view/` — Internal Console / MyConnect / Counter / Microsite (jQuery + Bootstrap). Works standalone (localStorage demo) or connected to backend (same-origin `/api/*`, badge `API ● connected`).
- `src/` — modular backend: `config`, `utils`, `db/` (seed, file store, finance), `auth/` (policy, sessions, RBAC), `routes/` (one module per domain), `app.js` (wiring). Entry: `server.js`.
- `server.js` — slim boot entry (`npm start`).


## Quick start (total solution)

```bat
npm install
npm start
```

Open **http://localhost:3000**

- App: `http://localhost:3000/`
- Anonymous microsite: `http://localhost:3000/?view=microsite&r=SAPAWO-AN-88`
- Health: `http://localhost:3000/api/health`

Demo logins: `tenant@sapawoo.vn / admin123`, `manager@number160.vn / staff123`, `staff@number160.vn / staff123`, `partner@company.vn / partner123`, `platform@sapawoo.vn / admin123` (needs support reason).

## How frontend ↔ backend are linked

- `view/js/api.js` — fetch wrapper, token in `localStorage connect_token`, `health()` probe.
- Login: tries `POST /api/auth/login` first, falls back to local demo when backend unreachable.
- After login: `GET /api/db` scoped snapshot replaces local DB.
- Voucher activation + counter validate/redeem: backend-first (`/api/vouchers/activate`, `/api/counter/*`), local fallback.
- Badge `#api-badge` shows `API ● connected` vs `API ○ local`.

## Backend notes

- File DB `data.json` auto-seeded, atomic tmp+rename writes, audit log, 8h sessions, 5/5min rate limit, server-side finance (`discount → payable → VAT removal → netNet → commissions`), idempotent redeem, settlement payout-verification gate.

## API

- `GET /api/health`
- `POST /api/auth/login` `{email,pass,role,supportReason}` → `{token,user,role,scope}`
- `POST /api/auth/logout`, `GET /api/me`, `GET /api/db` (scoped snapshot)
- `GET /api/:col` — partners|locations|referrers|budgets|media|cards|services|vouchers|redemptions|payouts|settlements|audits|events
- `POST /api/partners`, `POST /api/partners/:id/transition`
- `POST /api/locations`, `DELETE /api/locations/:id`
- `POST /api/referrers`, `POST /api/referrers/:id/transition`
- `POST /api/budgets`, `POST /api/media`, `POST /api/media/:id/replace|block`
- `POST /api/cards`, `POST /api/cards/:id/transition`
- `POST /api/vouchers/activate` `{code,deviceId,force?}` (anonymous, no auth)
- `POST /api/counter/validate|redeem` (auth, redeem = staff/manager/tenant)
- `POST /api/redemptions/:id/void` `{reason}` (manager)
- `POST /api/payouts`, `POST /api/payouts/:id/verify`
- `POST /api/settlements` `{itemIds,amount?,ref?,note?,evidence,confirm:true}`
- `POST /api/services`, `PUT /api/site`, `PUT /api/settings`
- `GET /api/reports/funnel`

Auth: `Authorization: Bearer <token>`. Rate limit 5/5min, 8h session expiry.
Demo logins: `tenant@sapawoo.vn/admin123`, `manager@number160.vn/staff123`, `partner@company.vn/partner123`.

## Railway deployment

Railway auto-detects Node (Nixpacks). This repo ships `railway.toml` + `Procfile` + `.nvmrc`:

1. Push to GitHub, **New Project → Deploy from Repo** in Railway.
2. No build config needed — defaults work: install via `npm install`, start via `npm start`, healthcheck `GET /api/health`.
3. Railway injects `PORT` automatically (already honored via `src/config.js`); the app binds `0.0.0.0`.

**Persistence:** Railway's filesystem is ephemeral — `data.json` reseeds on each redeploy unless you attach a volume:

1. Railway service → **Volumes → Add Volume**, mount path `/data`.
2. Set env var `DATA_FILE=/data/data.json` (or `DATA_DIR=/data`).
3. Redeploy — the store is created/loaded at that path from then on.

Useful env vars: `PORT` (auto), `HOST` (default `0.0.0.0`), `DATA_FILE`, `DATA_DIR`, `FRONT_DIR`, `JSON_LIMIT`.