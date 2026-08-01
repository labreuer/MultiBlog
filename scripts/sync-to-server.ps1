# Copy the files git reports as changed up to a deployed instance, without
# committing or pushing. For trying a work-in-progress change on a real box;
# the supported way to ship is DEPLOY.md §10 (`git pull` + deploy/deploy.sh).
#
# Usage:
#   pwsh -NoProfile -File scripts/sync-to-server.ps1 -Target deploy@thicketry.org:/srv/thicketry
#   ... -DryRun          list what would go, copy nothing
#   ... -Force           skip the confirmation prompt
#
# "Changed" means, against HEAD:
#   * tracked files added/modified/renamed, staged or not  (git diff HEAD)
#   * untracked files git would let you add                (git ls-files -o)
# Ignored files are excluded by construction, so a local .env can never be
# copied over the server's — which is the failure this would otherwise invite,
# given .env is the one file guaranteed to differ between the two.
#
# Locally DELETED files are reported but never acted on. Deleting on the server
# is not something a sync-my-edits helper should infer: the same absence means
# "I removed this" and "I have not written it yet."
#
# WHY THIS PUTS THE SERVER OUT OF SYNC WITH GIT, AND WHAT THAT COSTS
# The box's /srv/<instance> is a git clone, and deploy/deploy.sh opens with
# `git pull`. Files copied here are uncommitted local edits landing on top of
# tracked files, so the next deploy either overwrites them silently (if the
# same paths changed upstream, git refuses and the pull aborts) or leaves them
# in place indefinitely, diverging from what the repo says is deployed. Treat
# anything sent this way as temporary, and land it properly afterwards.
#
# LINE ENDINGS ARE NORMALIZED TO LF BEFORE SENDING, NOT LEFT AS-IS
# git checks these files out with CRLF locally whenever core.autocrlf converts
# them (the repeated "LF will be replaced by CRLF" warnings elsewhere in this
# project are that setting in action) -- a raw `scp` would ship that CRLF to
# the Linux box verbatim, which the Linux git clone stores as LF everywhere.
# Detection and conversion both happen at the byte level, never by re-reading
# the file as text: a text-mode round trip risks silently changing encoding or
# adding/dropping a BOM, which corrupting-to-fix-corruption is worse than the
# CRLF it would replace. A file is treated as binary (sent untouched) if a NUL
# byte turns up in its first 8000 bytes -- the same heuristic git itself uses -
# so a stray .png or .woff2 caught up in "changed files" is never rewritten.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Target,           # user@host:/absolute/remote/path
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# git's own binary-detection heuristic: a NUL byte anywhere in the first 8000
# bytes means binary. Sampling (not reading the whole file) keeps this cheap
# even for a large asset that happens to be in the changed-files list.
function Test-IsBinaryFile([byte[]]$Bytes) {
    $sampleLength = [Math]::Min(8000, $Bytes.Length)
    for ($i = 0; $i -lt $sampleLength; $i++) {
        if ($Bytes[$i] -eq 0) { return $true }
    }
    return $false
}

# Byte-level CRLF -> LF. Deliberately not a text-mode read/replace/write: that
# round trip risks PowerShell re-encoding the file or adding/stripping a BOM,
# which would corrupt it in a different way than the CRLF it's meant to fix.
# A lone CR (no following LF -- old Mac line endings, not used anywhere in
# this repo) is left untouched rather than guessed at.
function Convert-CrlfToLf([byte[]]$Bytes) {
    $out = [System.Collections.Generic.List[byte]]::new($Bytes.Length)
    for ($i = 0; $i -lt $Bytes.Length; $i++) {
        if ($Bytes[$i] -eq 0x0D -and $i + 1 -lt $Bytes.Length -and $Bytes[$i + 1] -eq 0x0A) {
            continue # drop the CR; the LF right after it is appended on the next iteration
        }
        $out.Add($Bytes[$i])
    }
    return , $out.ToArray() # unary comma: keep a single-byte result an array, not unwrapped to a scalar
}

# One pass per file, shared by -DryRun's preview and the real copy loop below,
# so what gets reported is exactly what would happen -- not two independently
# maintained guesses at the same thing.
function Get-SyncPlan([string[]]$RepoRelativePaths) {
    foreach ($path in $RepoRelativePaths) {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $isBinary = Test-IsBinaryFile $bytes
        $lfBytes = if ($isBinary) { $bytes } else { Convert-CrlfToLf $bytes }
        [PSCustomObject]@{
            Path      = $path
            Posix     = $path.Replace('\', '/')
            IsBinary  = $isBinary
            Converted = -not $isBinary -and $lfBytes.Length -ne $bytes.Length
            Bytes     = $lfBytes
        }
    }
}

if ($Target -notmatch '^([^@]+@[^:]+):(/.+)$') {
    Write-Error "-Target must look like user@host:/absolute/path (got '$Target')."
    exit 1
}
$sshHost = $Matches[1]
$remoteRoot = $Matches[2].TrimEnd('/')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    # --diff-filter=d drops deletions: their paths are exactly the ones that no
    # longer exist locally, so scp would fail on every one.
    $tracked = @(git diff --name-only --diff-filter=d HEAD)
    $untracked = @(git ls-files --others --exclude-standard)
    $deleted = @(git diff --name-only --diff-filter=D HEAD)

    $files = @($tracked + $untracked | Where-Object { $_ } | Sort-Object -Unique)

    if ($deleted.Count -gt 0) {
        Write-Host "`nDeleted locally -- NOT removed on the server, remove by hand if you meant to:" -ForegroundColor Yellow
        $deleted | ForEach-Object { Write-Host "  $_" }
    }

    if ($files.Count -eq 0) {
        Write-Host "`nNothing to copy -- no changed or untracked files."
        exit 0
    }

    $plan = @(Get-SyncPlan $files)

    Write-Host "`n$($files.Count) file(s) -> ${sshHost}:$remoteRoot"
    foreach ($item in $plan) {
        $suffix = if ($item.IsBinary) { ' (binary, sent as-is)' } elseif ($item.Converted) { ' (CRLF -> LF)' } else { '' }
        Write-Host "  $($item.Path)$suffix"
    }

    # What the copy alone will NOT do. Reported from the paths themselves so
    # the follow-up isn't left to memory.
    $needs = [ordered]@{}
    if ($files | Where-Object { $_ -like 'package.json' -or $_ -like 'package-lock.json' }) {
        $needs['npm ci'] = 'dependency manifest changed'
    }
    if ($files | Where-Object { $_ -like 'prisma/*' }) {
        $needs['npx prisma generate && npx prisma migrate deploy'] = 'schema or migrations changed'
    }
    if ($files | Where-Object { $_ -like 'src/*' -or $_ -like 'next.config.*' -or $_ -like '*.css' }) {
        $needs['NODE_OPTIONS="--max-old-space-size=3072" npm run build'] = 'app code changed (DEPLOY.md §2h)'
    }
    if ($files | Where-Object { $_ -like 'server/*' }) {
        $needs['restart the collab unit'] = 'collab server changed'
    }

    if ($DryRun) {
        Write-Host "`nDry run -- nothing copied."
        if ($needs.Count -gt 0) {
            Write-Host "`nWould still need, on the box:"
            $needs.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key)   # $($_.Value)" }
        }
        exit 0
    }

    if (-not $Force) {
        $answer = Read-Host "`nCopy these to $Target ? [y/N]"
        if ($answer -notmatch '^[Yy]') {
            Write-Host 'Aborted.'
            exit 0
        }
    }

    # scp will not create missing parent directories, and a new file in a new
    # folder is the common case for this script -- so mkdir -p every distinct
    # target directory first, in one ssh round trip rather than one per file.
    $dirs = @(
        $files | ForEach-Object { Split-Path $_ -Parent } |
            Where-Object { $_ } |
            ForEach-Object { $_.Replace('\', '/') } |
            Sort-Object -Unique
    )
    if ($dirs.Count -gt 0) {
        $quoted = ($dirs | ForEach-Object { "'$remoteRoot/$_'" }) -join ' '
        Write-Host "`nCreating remote directories..."
        & ssh $sshHost "mkdir -p $quoted"
        if ($LASTEXITCODE -ne 0) { Write-Error "Remote mkdir failed."; exit 1 }
    }

    # Reused across iterations rather than one temp file per item: each is
    # written and scp'd before the next overwrites it, so nothing is read
    # back after it's stale, and there's a single path to clean up after.
    $stagingPath = Join-Path $env:TEMP "sync-to-server-staging-$PID.tmp"
    $failed = @()
    try {
        foreach ($item in $plan) {
            Write-Host "  -> $($item.Posix)"
            $source = if ($item.Converted) {
                [System.IO.File]::WriteAllBytes($stagingPath, $item.Bytes)
                $stagingPath
            } else {
                # Binary or already-LF: sent byte-identical from its own path,
                # not round-tripped through a write it doesn't need.
                $item.Path
            }
            & scp -q -- $source "${sshHost}:$remoteRoot/$($item.Posix)"
            if ($LASTEXITCODE -ne 0) { $failed += $item.Path }
        }
    } finally {
        Remove-Item $stagingPath -Force -ErrorAction SilentlyContinue
    }

    if ($failed.Count -gt 0) {
        Write-Host "`nFailed to copy $($failed.Count) file(s):" -ForegroundColor Red
        $failed | ForEach-Object { Write-Host "  $_" }
        exit 1
    }

    Write-Host "`nCopied $($files.Count) file(s)."
    if ($needs.Count -gt 0) {
        Write-Host "`nStill needed, on the box (a copy alone changes nothing that is running):"
        $needs.GetEnumerator() | ForEach-Object { Write-Host "  $($_.Key)   # $($_.Value)" }
    }
}
finally {
    Pop-Location
}
