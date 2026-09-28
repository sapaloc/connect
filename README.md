# Connect V1

Partner referral, voucher and commission app for Number160.

## Structure

```text
apps/web/         Vite + Bootstrap static web (console, counter, my, public pages)
apps/api/         Node 22 API (node:http + pg), runs locally via server.js
packages/domain/  Roles, permissions, password policy shared by web and API (import from '#domain')
api/index.js      Vercel function entry that reuses apps/api
```

One `package.json` at the root holds every dependency and script.

`apps/api/src/config/env.js` is the only file that reads environment variables. See `.env.example`.

## Local development

```bash
pnpm install
cp .env.example .env      # point DATABASE_URL at a local Postgres
pnpm migrate
pnpm dev                  # web http://localhost:5173, api http://localhost:3000
```

Health check: `GET /api/v1/health`.

## Accounts

```bash
pnpm seed                 # local/test/uat (refused on production): Platform Admin, Tenant Admin, Manager, Staff,
                          # multi-role user (emails in apps/api/src/db/seed-local.js, password = SEED_PASSWORD)
DATABASE_URL=<uat pooler url> pnpm user:create --email a@b.vn --name "Name" --role TENANT_ADMIN --tenant Number160
```

UAT gets the same accounts on every deploy (after migrations) with the password from the `UAT_SEED_PASSWORD`
secret; share it privately, never in the repo. `user:create` prompts for the password; it is never passed as an argument or committed. Other people are
invited from Console → Team; the invitation (72h) and reset (1h) links are shown once to the admin, who sends
them by Zalo or email.

## Tests

Integration tests use `.env.test` and drop the `public` schema of `connect_test`, so run them against a
throwaway Postgres only (same image and port as CI `domain-tests`):

```bash
docker run -d --name connect-postgres -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=connect_test postgres:16-alpine
pnpm test                 # all packages
pnpm test:permission      # only @permission tests
```

## Branches

`feature/<issue>-<name>` → `develop` → `uat` (auto-deploys to Vercel `connect-uat`) → `master` (manual promotion).

## Deploy secrets (GitHub Actions)

`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `UAT_DATABASE_MIGRATION_URL` (Supabase session pooler, port 5432),
`UAT_SEED_PASSWORD` (optional; test account password on UAT, must meet the password policy).
