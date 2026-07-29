# Read-only guard for `npm run e2e`, run before Playwright starts.
#
# playwright.config.ts sets `reuseExistingServer: true` unconditionally against
# a hardcoded localhost:3000/:1234 (CLAUDE.md is explicit that a dev server we
# didn't start isn't ours to kill), and webServer.url treats *any* HTTP
# response as "ready" -- including a 404 from a completely different app. If
# some other project is squatting on either port, Playwright silently adopts
# it and the suite dies deep inside auth.setup.ts on a bad response, which
# reads exactly like an auth regression and isn't one.
#
# This is the same ownership check as stop-dev.ps1 -- the listening process's
# CommandLine must mention this repo's own path -- minus the killing. Ports
# with nothing listening are fine (Playwright starts them); ports already
# owned by this repo are fine (Playwright reuses them); anything else fails
# fast with the offending PID and command line instead of a 60s timeout.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$ports = @(3000, 1234)

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
    Write-Host "Stop it yourself, or run scripts/stop-dev.ps1 if it's safe to kill."
    exit 1
}

Write-Host "`nPorts 3000 and 1234 are clear or already ours."
