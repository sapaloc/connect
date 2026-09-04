# Connect — total solution (frontend + backend)

- `frontend/` — Internal Console / MyConnect / Counter / Microsite (jQuery + Bootstrap). Works standalone (localStorage demo) or connected to backend (same-origin `/api/*`, badge `API ● connected`).
- `backend/` — Node.js + Express + file NoSQL (`data.json`). Serves API + frontend statically.

## Quick start (total solution)

```bat
cd backend
npm install
npm start
```

Open **http://localhost:3000**

- App: `http://localhost:3000/`
- Anonymous microsite: `http://localhost:3000/?view=microsite&r=SAPAWO-AN-88`
- Health: `http://localhost:3000/api/health`

Demo logins: `tenant@sapawoo.vn / admin123`, `manager@number160.vn / staff123`, `staff@number160.vn / staff123`, `partner@company.vn / partner123`, `platform@sapawoo.vn / admin123` (needs support reason).

## How frontend ↔ backend are linked

- `frontend/js/api.js` — fetch wrapper, token in `localStorage connect_token`, `health()` probe.
- Login: tries `POST /api/auth/login` first, falls back to local demo when backend unreachable.
- After login: `GET /api/db` scoped snapshot replaces local DB.
- Voucher activation + counter validate/redeem: backend-first (`/api/vouchers/activate`, `/api/counter/*`), local fallback.
- Badge `#api-badge` shows `API ● connected` vs `API ○ local`.

## Backend notes

- File DB `backend/data.json` auto-seeded, atomic tmp+rename writes, audit log, 8h sessions, 5/5min rate limit, server-side finance (`discount → payable → VAT removal → netNet → commissions`), idempotent redeem, settlement payout-verification gate.
