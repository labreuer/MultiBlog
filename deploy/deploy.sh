#!/usr/bin/env bash
# MultiBlog redeploy script — for SUBSEQUENT deploys, not the first one.
# The first deploy (provisioning, .env, create-admin, systemd/nginx install)
# is the manual sequence in DEPLOY.md §2-§7. Run this from the app's own
# clone (e.g. /srv/multiblog) as the `deploy` user once that's all in place.
#
# NEXT_PUBLIC_COLLAB_URL and DATABASE_URL are read from that clone's own
# .env automatically (next build loads .env; prisma loads it via
# prisma.config.ts), so no manual export is needed here.
#
# Safe to reuse unmodified for a second instance on the same box (e.g. a
# second subdomain/DB, see DEPLOY.md §11) — it cd's to wherever this script
# itself lives, not a hardcoded path, and the systemd unit names default to
# <that directory's own name>-web/-collab (so /srv/multiblog -> multiblog-web/
# multiblog-collab, /srv/uniblog -> uniblog-web/uniblog-collab — matching
# DEPLOY.md §11's convention of naming the directory after the instance).
# Override if a unit's name doesn't follow that convention:
#   WEB_UNIT=some-other-name COLLAB_UNIT=some-other-name-collab ./deploy/deploy.sh
#
# The systemctl restart below needs passwordless sudo for these two units —
# `deploy`'s plain sudo-group membership alone still prompts for a password,
# which breaks this non-interactive run. See DEPLOY.md §6 for the one-time
# /etc/sudoers.d/multiblog NOPASSWD grant this depends on (a second instance
# needs its own such grant for its own unit names).
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INSTANCE="$(basename "$PWD")"
WEB_UNIT="${WEB_UNIT:-${INSTANCE}-web}"
COLLAB_UNIT="${COLLAB_UNIT:-${INSTANCE}-collab}"

echo "==> Pulling latest"
git pull

echo "==> Installing dependencies (incl. dev deps: prisma/tsx/typescript are runtime here)"
npm ci

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying migrations"
npx prisma migrate deploy

echo "==> Building Next.js app"
# On a 1 GB Nanode, V8 auto-sizes its heap ceiling from physical RAM alone
# (ignores swap), so the default is too low to get through the build even
# with swap free. Raise it explicitly. See DEPLOY.md §2h.
time NODE_OPTIONS="--max-old-space-size=3072" npm run build

echo "==> Restarting services"
sudo systemctl restart "$WEB_UNIT" "$COLLAB_UNIT"

echo "==> Done."
systemctl --no-pager status "$WEB_UNIT" "$COLLAB_UNIT" | sed -n '1,12p'
echo "==> Total deploy time: ${SECONDS}s"
