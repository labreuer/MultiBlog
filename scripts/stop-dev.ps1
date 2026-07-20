# Stops this repo's `npm run dev:all` tree (Next.js on :3000 + Hocuspocus on :1234)
# in one shot, so a restart doesn't need a separate discover/trace/kill round trip.
#
# Verifies before killing anything:
#   - the process actually listening on each port must have this repo's own path in
#     its CommandLine (the real leaf processes -- next's start-server.js, tsx's
#     collab.ts entry point -- always do, since they're invoked via absolute
#     node_modules paths). If a port owner doesn't match, that port is left alone.
#   - each ancestor added to the kill list must itself match a known dev:all-related
#     pattern (concurrently, npm run dev/collab, next dev, tsx watch, or the repo
#     path again). The walk stops climbing at the first ancestor that doesn't match,
#     so it can never reach past this project's process tree into an unrelated
#     parent shell.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$ports = @(3000, 1234)
$ancestorMarkers = @(
    $repoRoot, 'concurrently', 'npm run dev:all', 'npm:dev', 'npm:collab',
    'npm run dev', 'npm run collab', 'npm-cli.js', 'next dev', 'tsx watch'
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
Write-Host "`nPorts 3000 and 1234 are clear."
