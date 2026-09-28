# Connect V1

Partner referral, voucher and commission app for Number160.

## Structure

```text
apps/web/     Vite + Bootstrap static web (console, counter, my, public pages)
apps/api/     Node 22 API (node:http + pg), runs locally via server.js
api/index.js  Vercel function entry that reuses apps/api
```

`apps/api/src/config/env.js` is the only file that reads environment variables. See `.env.example`.

## Local development

```bash
pnpm install
cp .env.example .env      # point DATABASE_URL at a local Postgres
pnpm migrate
pnpm dev                  # web http://localhost:5173, api http://localhost:3000
```

Health check: `GET /api/v1/health`.

## Branches

`feature/<issue>-<name>` → `develop` → `uat` (auto-deploys to Vercel `connect-uat`) → `master` (manual promotion).

## Deploy secrets (GitHub Actions)

`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `UAT_DATABASE_MIGRATION_URL` (Supabase session pooler, port 5432).
