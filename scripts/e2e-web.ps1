# The e2e suite's production web server: `next build`, then `next start` on
# :3005 — dev's 3000 + 5, so it coexists with `dev:all` (:3000) and the preview
# tool's web-prod (:3001). Launched by playwright.config.ts's webServer when
# E2E_TARGET=prod and nothing is already listening there; with
# reuseExistingServer a server left running skips the rebuild on later runs.
#
# The full suite targets the prod build rather than `next dev` because two of
# the suite's historical failure classes are dev-only — the prerender-manifest
# RMW tear (vercel/next.js#96664) and next-auth's dev-only SessionProvider
# invariant 500 — and both are compiled out of a production build. Next's own
# Playwright guide recommends exactly this. Full account:
# docs/playwright-flakiness.html.
#
# AUTH_TRUST_HOST/AUTH_URL for the same reason .claude/launch.json's web-prod
# sets them: NextAuth under `next start` rejects localhost as an UntrustedHost
# without them (CACHING.md's 2026-07-24 entry).
$ErrorActionPreference = 'Stop'

$env:AUTH_TRUST_HOST = 'true'
$env:AUTH_URL = 'http://localhost:3005'
# The invite flow builds absolute URLs from APP_URL; .env's copy says :3000
# (the dev server), which this server is not — without the override,
# invite.spec navigates to a port nothing is listening on.
$env:APP_URL = 'http://localhost:3005'
# Enables /api/test/revalidate (see that route's header): fixtures write the
# DB directly, so on an ISR'd page only an explicit revalidation makes the
# write visible within the revalidate window.
$env:E2E_REVALIDATE = '1'

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx next start -p 3005
