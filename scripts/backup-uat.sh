#!/bin/sh
# Daily UAT backup onto this machine (macOS launchd, see README "Backups"). Never commit backups: the repo is public.
set -eu
cd "$(dirname "$0")/.."
exec node --env-file="${CONNECT_BACKUP_ENV:-$HOME/.config/connect/uat.env}" apps/api/src/db/db-backup.js \
  --out "${CONNECT_BACKUP_DIR:-$HOME/Backups/connect-uat}" --keep 30
