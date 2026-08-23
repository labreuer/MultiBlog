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
# `npm ci` runs only when the pull actually changed package.json or
# package-lock.json — see the block below for why that is skipped outright
# rather than softened to `npm i`. FORCE_INSTALL=1 overrides:
#   FORCE_INSTALL=1 ./deploy/deploy.sh
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
BEFORE_PULL="$(git rev-parse HEAD)"
git pull

# Skip the install when the pull did not touch the dependency manifests. On a
# 970 MB node_modules this is the single biggest win available to a redeploy:
# `npm ci` deletes and refills the tree every time, measured at ~18s whether or
# not anything changed, against a ~55s deploy.
#
# Deliberately NOT `npm i` as the fast path. `npm i` reconciles in ~3.5s, but:
#   - it can rewrite package-lock.json when anything drifts (npm version,
#     platform-specific optional deps). This script starts with `git pull`, so
#     a lock modified on the server becomes a merge conflict on the NEXT
#     deploy — the same failure DEPLOY.md §5 warns about for editing
#     package.json on the box, reached by a different route.
#   - it reconciles rather than replaces, so packages orphaned by an earlier
#     dependency set survive and node_modules slowly diverges from what a
#     clean install produces.
# Skipping entirely is both faster than `npm i` and exactly as deterministic
# as `npm ci`, because it only happens when the inputs to `npm ci` are
# byte-identical to the ones that produced the current tree.
#
# FORCE_INSTALL=1 re-installs unconditionally — for the one case the git
# comparison cannot see: a previous run whose `npm ci` died partway, leaving a
# node_modules that exists but is incomplete.
if [ "${FORCE_INSTALL:-0}" = 1 ]; then
    echo "==> Installing dependencies (FORCE_INSTALL=1)"
    npm ci
elif [ ! -d node_modules ]; then
    echo "==> Installing dependencies (no node_modules yet)"
    npm ci
elif git diff --quiet "$BEFORE_PULL" HEAD -- package.json package-lock.json; then
    echo "==> Dependencies unchanged since $(git rev-parse --short "$BEFORE_PULL") — skipping npm ci"
else
    echo "==> Dependencies changed — npm ci (incl. dev deps: prisma/tsx/typescript are runtime here)"
    npm ci
fi

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

# Wait for the app to actually answer before declaring the deploy done.
#
# Both units are Type=simple, so systemd marks them active the instant it
# FORKS the process — not when `next start` has bound its port. `systemctl
# status` showing "active" immediately after a restart is therefore not
# evidence the site is up, and the `status` call below would happily print a
# green unit over a dead upstream.
#
# The window is short but real: measured on a 2-vCPU box, nginx logged
# `connect() failed (111: Connection refused) ... upstream: 127.0.0.1:3000`
# for a request that arrived in the ~1s between the restart and `✓ Ready`.
# A deploy that returns while the site still 502s is the kind of failure you
# only notice from someone else's bug report.
#
# The port comes from the unit's own Environment= (DEPLOY.md §6), not from
# .env — `next start` reads PORT, which the unit sets and .env does not. That
# also keeps this correct for a second instance on another port (§11).
WEB_PORT="$(systemctl show "$WEB_UNIT" -p Environment --value \
            | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
WEB_PORT="${WEB_PORT:-3000}"

echo "==> Waiting for $WEB_UNIT to answer on :$WEB_PORT"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
for i in $(seq 1 "$READY_TIMEOUT"); do
    # `|| true`: curl exits non-zero on a refused connection, which is the
    # expected state early in this loop and must not trip `set -e`.
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' \
            "http://127.0.0.1:$WEB_PORT/" || true)"
    if [ "$code" = 200 ]; then
        echo "    ready after ${i}s"
        break
    fi
    if [ "$i" -eq "$READY_TIMEOUT" ]; then
        echo "    NOT READY after ${READY_TIMEOUT}s — last response: HTTP $code" >&2
        systemctl --no-pager status "$WEB_UNIT" | sed -n '1,12p' >&2
        journalctl -u "$WEB_UNIT" -n 20 --no-pager >&2
        exit 1
    fi
    sleep 1
done

echo "==> Done."
systemctl --no-pager status "$WEB_UNIT" "$COLLAB_UNIT" | sed -n '1,12p'
echo "==> Total deploy time: ${SECONDS}s"
