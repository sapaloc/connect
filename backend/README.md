# Connect backend

Express + file NoSQL (`data.json`). Serves both API and frontend.

## Run

```bat
cd backend
npm install
npm start
```

Open http://localhost:3000 — frontend is served statically.
Anonymous microsite: http://localhost:3000/?view=microsite&r=SAPAWO-AN-88

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

## Data

Single JSON file `data.json` (auto-created from seed, atomic tmp+rename writes).
