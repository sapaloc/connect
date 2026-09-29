# Connect V1

Partner referral, voucher and commission app for Number160.

## Structure

```text
apps/web/         Vite + Bootstrap static web (console, counter, my, public pages)
apps/api/         Node 22 API (node:http + MongoDB driver), runs locally via server.js
packages/domain/  Roles, permissions, password policy shared by web and API (import from '#domain')
api/index.js      Vercel function entry that reuses apps/api
```

One `package.json` at the root holds every dependency and script.

`apps/api/src/config/env.js` is the only file that reads environment variables. See `.env.example`.

## Database

MongoDB: Atlas (created from the Vercel Marketplace, which sets `MONGODB_URI`) on UAT, Docker locally.
Transactions need a replica set, so the local container runs one:

```bash
docker run -d --name connect-mongo -p 27017:27017 mongo:7 --replSet rs0
docker exec connect-mongo mongosh --eval 'rs.initiate()'
```

`pnpm db:setup` creates the collections with `$jsonSchema` validation, unique and TTL indexes
(`apps/api/src/db/setup.js`). It is safe to re-run and runs on every UAT deploy. When a validator or index
changes, bump `SCHEMA_VERSION` and keep old documents valid (add optional fields first, backfill, then require).

## Backups

Atlas Free has no backups, so Vercel Cron calls `GET /api/v1/internal/jobs/backup` every day at 02:00 Vietnam
time (`vercel.json`, protected by `CRON_SECRET`). It exports every collection except sessions and rate limits as
canonical Extended JSON (Decimal128, dates and binary kept exactly), gzipped, to the private Supabase Storage
bucket `connect-files` under `backups/<APP_ENV>/`, and keeps the newest 30.

```bash
MONGODB_URI=<uat uri> APP_ENV=uat pnpm db:backup          # download a copy now into ./backups (gitignored)
pnpm db:restore --file backups/<file>.json.gz --confirm local   # replace ALL data (local/test/uat only)
```

Download a daily file from Supabase → Storage → `connect-files` → `backups/uat`. Backups contain password
hashes: keep them out of the repo and chat.

## Local development

```bash
pnpm install
cp .env.example .env      # MONGODB_URI points at the local container
pnpm db:setup
pnpm dev                  # web http://localhost:5173, api http://localhost:3000
```

Health check: `GET /api/v1/health`.

## Accounts

```bash
pnpm seed                 # local/test/uat (refused on production): Platform Admin, Tenant Admin, Manager, Staff,
                          # multi-role user (emails in apps/api/src/db/seed-local.js, password = SEED_PASSWORD)
MONGODB_URI=<uat uri> pnpm user:create --email a@b.vn --name "Name" --role TENANT_ADMIN --tenant Number160
```

`pnpm seed` only creates the accounts the first time; later runs skip, so passwords and roles changed during
testing are kept. UAT runs it after `db:setup` on every deploy (password from the `UAT_SEED_PASSWORD` secret,
used only on that first run). Share the password privately, never in the repo.

To start over with an empty database plus fresh test accounts (local/test/uat only, never production):

```bash
pnpm db:reset --confirm local   # --confirm must repeat APP_ENV
```

On UAT use GitHub Actions → **Reset UAT database** → Run workflow on `uat`, typing `reset uat`. `user:create` prompts for the password; it is never passed as an argument or committed. Other people are
invited from Console → Team; the invitation (72h) and reset (1h) links are shown once to the admin, who sends
them by Zalo or email.

## Tests

Integration tests use `.env.test` and drop the `connect_test` database, so run them against the local
container only (same image and replica set as CI `domain-tests`):

```bash
pnpm test                 # all packages
pnpm test:permission      # only @permission tests
```

## Branches

`feature/<issue>-<name>` → `develop` → `uat` (auto-deploys to Vercel `connect-uat`) → `master` (manual promotion).

## Deploy secrets (GitHub Actions)

`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `UAT_MONGODB_URI` (same value as `MONGODB_URI` on Vercel),
`UAT_SEED_PASSWORD` (optional; test account password on UAT, must meet the password policy).

Vercel env (Production): `MONGODB_URI` (from the Atlas integration), `MONGODB_DB=connect`, `SESSION_SECRET`, `CRON_SECRET`,
`APP_ENV=uat`, `APP_ORIGIN`, `MICROSITE_PUBLIC_BASE_URL`, `STORAGE_*` (Supabase Storage for files).
