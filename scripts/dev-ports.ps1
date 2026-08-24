# Hand-kept mirror of scripts/dev-ports.ts — the slot's hostname and port block,
# for the three PowerShell scripts that need them (check-ports.ps1,
# stop-all.ps1, e2e-web.ps1).
#
# Duplicated rather than shelled out to `npx tsx scripts/dev-ports.ts`: check-ports
# runs as a prestep of every `npm run e2e`, and a cold node start in front of the
# port guard is a worse trade than twenty lines of parsing. The rationale for the
# values themselves — why DEV_HOST exists at all, why the derived ports are +1 and
# +5, why `*.localhost` beats a hosts-file entry — lives in dev-ports.ts and is not
# repeated here. Change one file, change the other.
#
# Dot-sourcing is deliberately not used: this returns an object, so a caller writes
#   $slot = & "$PSScriptRoot\dev-ports.ps1"
# and there is no question about which variables leaked into its scope.

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$envFile = Join-Path $repoRoot '.env'

$values = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        # A leading '#' can't match, since the key class doesn't include it.
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $value = $Matches[2].Trim()
            if ($value.Length -ge 2 -and
                (($value[0] -eq '"' -and $value[-1] -eq '"') -or
                 ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$Matches[1]] = $value
        }
    }
}

function Get-SlotPort($name, $fallback) {
    $raw = $values[$name]
    $parsed = 0
    if ($raw -and [int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
    return $fallback
}

$webPort = Get-SlotPort 'WEB_PORT' 3000
$devHost = if ($values['DEV_HOST']) { $values['DEV_HOST'] } else { 'localhost' }

[pscustomobject]@{
    RepoRoot = $repoRoot
    DevHost  = $devHost
    Web      = $webPort
    WebProd  = $webPort + 1
    E2eWeb   = $webPort + 2
    Collab   = Get-SlotPort 'COLLAB_PORT' 1234
}
