# The e2e suite's production web server: `next build`, then `next start` on
# WEB_PORT + 2 — :3002 in slot A, so it coexists with `dev:all` (:3000) and the
# preview tool's web-prod (:3001). Launched by playwright.config.ts's webServer when
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

# This slot's block, not literals (scripts/dev-ports.ts). The host matters as
# much as the port here: AUTH_URL and APP_URL below must name the same hostname
# playwright.config.ts's BASE_URL uses, or the suite signs in against one cookie
# host and then navigates on another.
$slot = & (Join-Path $PSScriptRoot 'dev-ports.ps1')
$baseUrl = "http://$($slot.DevHost):$($slot.E2eWeb)"

$env:AUTH_TRUST_HOST = 'true'
$env:AUTH_URL = $baseUrl
# The invite flow builds absolute URLs from APP_URL; .env's copy names the dev
# server, which this server is not — without the override,
# invite.spec navigates to a port nothing is listening on.
$env:APP_URL = $baseUrl
# Enables /api/test/revalidate (see that route's header): fixtures write the
# DB directly, so on an ISR'd page only an explicit revalidation makes the
# write visible within the revalidate window.
$env:E2E_REVALIDATE = '1'

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npx next start -p $($slot.E2eWeb)
