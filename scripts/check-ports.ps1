# Read-only guard for `npm run e2e`, run before Playwright starts.
#
# playwright.config.ts sets `reuseExistingServer: true` unconditionally against
# this slot's own web and collab ports (CLAUDE.md is explicit that a dev server we
# didn't start isn't ours to kill), and webServer.url treats *any* HTTP
# response as "ready" -- including a 404 from a completely different app. If
# some other project is squatting on either port, Playwright silently adopts
# it and the suite dies deep inside auth.setup.ts on a bad response, which
# reads exactly like an auth regression and isn't one.
#
# This is the same ownership check as stop-all.ps1 -- the listening process's
# CommandLine must mention this repo's own path -- minus the killing. Ports
# with nothing listening are fine (Playwright starts them); ports already
# owned by this repo are fine (Playwright reuses them); anything else fails
# fast with the offending PID and command line instead of a 60s timeout.

$ErrorActionPreference = 'Stop'

# This slot's block, not literals: a second working tree runs beside this one
# on its own WEB_PORT/COLLAB_PORT (scripts/dev-ports.ts). E2eWeb is WEB_PORT + 2,
# the e2e prod target. WebProd (WEB_PORT + 1) is deliberately absent — the
# preview tool owns that one, and Playwright never contends for it.
$slot = & (Join-Path $PSScriptRoot 'dev-ports.ps1')
$repoRoot = $slot.RepoRoot
$ports = @($slot.Web, $slot.E2eWeb, $slot.Collab)

# Tripwire for next dev's prerender-manifest corruption (vercel/next.js#96664,
# docs/playwright-flakiness.html class 3): the RMW race's *sticky* variant
# leaves the file unparseable, after which every route 500s until the dev
# server restarts — a state otherwise indistinguishable from "the suite broke".
# Only the dev server's copy matters; a prod build writes its manifest once.
$manifest = Join-Path $repoRoot '.next\dev\prerender-manifest.json'
if (Test-Path $manifest) {
    try {
        Get-Content $manifest -Raw | ConvertFrom-Json | Out-Null
    } catch {
        Write-Warning "$manifest is not valid JSON."
        Write-Warning "That's vercel/next.js#96664's sticky tear: every dev route will 500 until the dev server restarts."
        Write-Host "`nStop the dev server (npm run stop:all), delete .next, and start it again before running e2e."
        exit 1
    }
}

function Get-ProcCommandLine($procId) {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
}

$foreign = $false

foreach ($port in $ports) {
    $owningPids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    if (-not $owningPids) {
        Write-Host "Port $port -- nothing listening, Playwright will start it."
        continue
    }

    foreach ($ownerId in $owningPids) {
        $ownerCmd = Get-ProcCommandLine $ownerId
        if ($ownerCmd -and $ownerCmd.Contains($repoRoot)) {
            Write-Host "Port $port -- owned by this repo (PID $ownerId), Playwright will reuse it."
        } else {
            Write-Warning "Port $port is held by PID $ownerId, whose command line doesn't mention this repo:"
            Write-Warning "  $ownerCmd"
            $foreign = $true
        }
    }
}

if ($foreign) {
    Write-Host "`nRefusing to run e2e -- a required port is held by a process from another project."
    Write-Host "Stop it yourself, or run scripts/stop-all.ps1 if it's safe to kill."
    exit 1
}

Write-Host "`nPorts $($ports -join ', ') are clear or already ours."
