#!/usr/bin/env bash
# MultiBlog redeploy script — for SUBSEQUENT deploys, not the first one.
# The first deploy (provisioning, .env, create-admin, systemd/nginx install)
# is the manual sequence in DEPLOY.md §2-§7. Run this from /srv/multiblog as
# the `deploy` user once that's all in place.
#
# NEXT_PUBLIC_COLLAB_URL and DATABASE_URL are read from /srv/multiblog/.env
# automatically (next build loads .env; prisma loads it via prisma.config.ts),
# so no manual export is needed here.
#
# The systemctl restart needs passwordless sudo for these two units, e.g. a
# /etc/sudoers.d/multiblog line:
#   deploy ALL=(root) NOPASSWD: /bin/systemctl restart multiblog-web multiblog-collab
set -euo pipefail

cd /srv/multiblog

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
sudo systemctl restart multiblog-web multiblog-collab

echo "==> Done."
systemctl --no-pager status multiblog-web multiblog-collab | sed -n '1,12p'
echo "==> Total deploy time: ${SECONDS}s"
