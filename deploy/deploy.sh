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
# The install is an unconditional `npm ci` — the note above it says why not
# `npm i`, and why it is no longer skipped when the manifests look unchanged.
#
# Nothing the running site reads from is emptied while it runs. The install
# goes into .deploy/ and the build into .next-build/, and each is swapped in
# by rename (microseconds) just before the restart. A failed build leaves the
# live site exactly as it was. DEPLOY.md §10 has the steps and the rollback.
#
# The build's heap and niceness come from the environment. On a box running
# a second instance, keep the build from pushing the neighbour into swap
# (DEPLOY.md §2h, §11):
#   BUILD_HEAP_MB=1536 BUILD_NICE=10 ./deploy/deploy.sh
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
BUILD_HEAP_MB="${BUILD_HEAP_MB:-3072}"
BUILD_NICE="${BUILD_NICE:-0}"
export DEPLOY_STARTED="${DEPLOY_STARTED:-$(date +%s)}"

# Pull, then run the script the pull brought. git replaces a changed file
# rather than rewriting it, so without the exec bash would finish the deploy
# with the old script still open, and a change to this file would first take
# effect one deploy late.
if [ "${DEPLOY_PULLED:-}" != 1 ]; then
    export DEPLOY_PREV_HEAD="$(git rev-parse --short HEAD)"
    echo "==> Pulling latest (from $DEPLOY_PREV_HEAD)"
    git pull
    DEPLOY_PULLED=1 exec bash "$PWD/deploy/deploy.sh" "$@"
fi

# Leftovers from a run that stopped part way. Nothing live reads either.
rm -rf .deploy .next-build

# Always `npm ci`, and deliberately not either of these:
#   - `npm i`. It reconciles in ~3.5s against `npm ci`'s ~18s, but it can
#     rewrite package-lock.json when anything drifts (npm version,
#     platform-specific optional deps). This script starts with `git pull`, so
#     a lock modified on the server becomes a merge conflict on the NEXT
#     deploy — the same failure DEPLOY.md §5 warns about for editing
#     package.json on the box, reached by a different route. It also
#     reconciles rather than replaces, so packages orphaned by an earlier
#     dependency set survive and node_modules slowly diverges from what a
#     clean install produces.
#   - Skipping it when the manifests look unchanged. Tried (e738b1c) for the
#     ~18s it saved, and removed after two blind spots surfaced in production —
#     the second, a hand `git checkout <branch>` before the script so that its
#     own pull saw no change, skipped an install the branch needed and left a
#     live instance serving a half-deleted .next. The saving is not worth a
#     decision that can be wrong; the removing commit has the full account.
#
# `npm ci` deletes node_modules before it installs, so run in place it would
# leave the live process unable to load any module it hadn't yet required, for
# the ~20s of the install. So it runs in .deploy/, against copies of the two
# manifests, and the result is swapped in by rename. The old node_modules
# waits in .deploy/prev/ until the new build is in place: from the swap until
# then, any failure (generate, migrate, build) puts it back, so the live
# process never runs on dependencies it wasn't built against. A dot-directory
# and a directory named node_modules are both outside tsconfig's `**` globs,
# so the build's type check walks neither.
echo "==> Installing dependencies into .deploy/ (incl. dev deps: prisma/tsx/typescript are runtime here)"
mkdir -p .deploy/prev
cp package.json package-lock.json .deploy/
(cd .deploy && npm ci)

restore_node_modules() {
    if [ -d .deploy/prev/node_modules ]; then
        mv node_modules .deploy/failed-node_modules
        mv .deploy/prev/node_modules node_modules
    fi
    rm -rf .deploy .next-build
    echo "==> FAILED before the new build went in. The live site is untouched: it still" >&2
    echo "    serves its own .next with its own node_modules. The source tree is the pulled" >&2
    echo "    commit, so fix forward and deploy again rather than restarting the units." >&2
}
if [ -d node_modules ]; then mv node_modules .deploy/prev/node_modules; fi
mv .deploy/node_modules node_modules
trap restore_node_modules ERR

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying migrations"
npx prisma migrate deploy

echo "==> Building Next.js app into .next-build/ (heap ${BUILD_HEAP_MB} MB, nice ${BUILD_NICE})"
# `next build` empties its output directory first, so built in place it would
# leave the live process serving a half-deleted .next for the whole build, and
# for good if the build failed. NEXT_DIST_DIR (next.config.ts) points it at
# .next-build instead. .next-build sits at .next's depth on purpose: the
# build links its external packages as ../../node_modules/<pkg>, which only
# resolve after the rename from a directory at the same depth.
#
# It starts from a copy of .next/cache, which a build reads back: TypeScript's
# incremental record (.tsbuildinfo), the Server Actions encryption key
# (.rscinfo, kept 14 days so pages already open keep working across a deploy),
# the preview-mode keys and optimised images. Built in place, `next build`
# keeps that directory; a .next-build without it type-checks every file cold
# (3 min against 54s on a 1-vCPU box) and mints a new key on every deploy.
#
# The heap: V8 sizes its ceiling from physical RAM alone and ignores swap, so
# on a small box the default is too low to get through the build even with
# swap free (DEPLOY.md §2h).
if [ -d .next/cache ]; then mkdir -p .next-build && cp -a .next/cache .next-build/cache; fi
time nice -n "$BUILD_NICE" env NODE_OPTIONS="--max-old-space-size=$BUILD_HEAP_MB" NEXT_DIST_DIR=.next-build npm run build
trap - ERR

echo "==> Swapping in the new build, and restarting"
# The old process serves from the new .next only for the moment between this
# rename and the restart.
if [ -d .next ]; then mv .next .deploy/prev/next; fi
mv .next-build .next
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
        echo "    The previous build and node_modules are in .deploy/prev/, from commit" >&2
        echo "    ${DEPLOY_PREV_HEAD:-?}; DEPLOY.md §10 says how to roll back to them." >&2
        exit 1
    fi
    sleep 1
done

# Answering, so the previous build is no longer worth its ~1.2 GB.
rm -rf .deploy

# Claude's and Claude Code's published OAuth client documents, against the
# pins in src/lib/oauth/pinned-clients.ts (docs/MCP.md §21, "Which clients").
# It prints what it finds and never fails the deploy: nothing else would run
# it, and drift would otherwise first show as claude.ai failing to connect.
echo "==> Checking the pinned OAuth clients against their published documents"
npx tsx scripts/check-oauth-clients.ts || true

echo "==> Done."
systemctl --no-pager status "$WEB_UNIT" "$COLLAB_UNIT" | sed -n '1,12p'
echo "==> Total deploy time: $(( $(date +%s) - DEPLOY_STARTED ))s"
