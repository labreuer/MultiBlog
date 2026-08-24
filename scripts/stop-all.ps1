# Stops every server this repo runs locally, in one shot, so a restart doesn't
# need a separate discover/trace/kill round trip: the `npm run dev:all` tree
# (Next.js dev on WEB_PORT + Hocuspocus on COLLAB_PORT) and the e2e prod web
# server (`npm run e2e:web`, `next start` on WEB_PORT + 2). In slot A those are
# :3000, :1234 and :3002. Named for the `npm run stop:all` script that invokes
# it — it used to be stop-dev.ps1, before :3005 existed.
#
# Verifies before killing anything:
#   - the process actually listening on each port must have this repo's own path in
#     its CommandLine (the real leaf processes -- next's server entry, tsx's
#     collab.ts entry point -- always do, since they're invoked via absolute
#     node_modules paths). If a port owner doesn't match, that port is left alone.
#   - each ancestor added to the kill list must itself match a known server-tree
#     pattern (concurrently, npm run dev/collab/e2e:web, next dev/start, tsx watch,
#     or the repo path again). The walk stops climbing at the first ancestor that
#     doesn't match, so it can never reach past this project's process tree into an
#     unrelated parent shell.

$ErrorActionPreference = 'Stop'

# This slot's block, not literals — see scripts/dev-ports.ts. E2eWeb
# (WEB_PORT + 2) is the e2e prod web server (scripts/e2e-web.ps1); the same
# ownership check applies to it. WebProd (WEB_PORT + 1) stays out of the list on
# purpose: it belongs to the preview tool, which has to stop it itself (CACHING.md).
$slot = & (Join-Path $PSScriptRoot 'dev-ports.ps1')
$repoRoot = $slot.RepoRoot
$ports = @($slot.Web, $slot.E2eWeb, $slot.Collab)
$ancestorMarkers = @(
    $repoRoot, 'concurrently', 'npm run dev:all', 'npm:dev', 'npm:collab',
    'npm run dev', 'npm run collab', 'npm-cli.js', 'next dev', 'tsx watch',
    # `npm run dev` is a tsx wrapper now (scripts/dev-web.ts) that spawns next's
    # bin by absolute path, so the leaf's command line quotes that path and the
    # 'next dev' marker above (which expects a space, not a quote) no longer
    # matches it. It still matches $repoRoot; this entry makes that deliberate
    # rather than lucky.
    'dev-web.ts',
    # The e2e prod web tree (scripts/e2e-web.ps1). In practice every process in
    # it carries the repo's absolute path and already matches $repoRoot; these
    # make the intent explicit rather than relying on that alone.
    'npm run e2e:web', 'e2e-web.ps1', 'next start'
)

function Get-ProcCommandLine($procId) {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
}

function Test-AncestorMatch($commandLine) {
    if (-not $commandLine) { return $false }
    foreach ($marker in $ancestorMarkers) {
        if ($commandLine.Contains($marker)) { return $true }
    }
    return $false
}

$toKill = [ordered]@{}   # procId -> commandLine, deduped across both ports
$aborted = $false

foreach ($port in $ports) {
    $owningPids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique

    if (-not $owningPids) {
        Write-Host "Port $port -- nothing listening."
        continue
    }

    foreach ($leafId in $owningPids) {
        $leafCmd = Get-ProcCommandLine $leafId
        if (-not $leafCmd -or -not $leafCmd.Contains($repoRoot)) {
            Write-Warning "Port $port is owned by PID $leafId, but its command line doesn't mention this repo:"
            Write-Warning "  $leafCmd"
            Write-Warning "Refusing to touch it -- looks like a different process."
            $aborted = $true
            continue
        }

        $toKill[[string]$leafId] = $leafCmd

        # Walk up the parent chain, only including ancestors that match a known pattern.
        $currentId = $leafId
        while ($true) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
            if (-not $proc -or -not $proc.ParentProcessId) { break }
            $parentId = $proc.ParentProcessId
            $parentCmd = Get-ProcCommandLine $parentId
            if (-not (Test-AncestorMatch $parentCmd)) { break }
            $toKill[[string]$parentId] = $parentCmd
            $currentId = $parentId
        }
    }
}

if ($toKill.Count -eq 0) {
    if ($aborted) {
        Write-Host "Nothing killed -- see warnings above."
        exit 1
    }
    Write-Host "Nothing to stop."
    exit 0
}

Write-Host "`nAbout to stop $($toKill.Count) process(es):"
foreach ($procId in $toKill.Keys) {
    Write-Host "  $procId  $($toKill[$procId])"
}

foreach ($procId in $toKill.Keys) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "Stopped $procId"
    } catch {
        Write-Warning "Could not stop $procId (already gone?): $_"
    }
}

Start-Sleep -Milliseconds 500
$stillListening = foreach ($port in $ports) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
}
if ($stillListening) {
    Write-Warning "Still listening after kill attempt:"
    $stillListening | Format-Table LocalPort, OwningProcess
    exit 1
}

if ($aborted) {
    Write-Host "`nDone, but one port was left alone -- see warnings above."
    exit 1
}
Write-Host "`nPorts $($ports -join ', ') are clear."
