# Pulls a deployed instance's database down to a local Postgres database
# named frombackup_<db_name>, for poking at real data locally without ever
# putting write access to it in reach of anything running here.
#
# Usage:
#   pwsh -NoProfile -File scripts/pull-remote-db.ps1 -Instance thicketry
#     [-SshHost deploy@flow] [-LocalPgUser postgres] [-LocalPgHost 127.0.0.1]
#     [-Force] [-KeepDump]
#
# -Instance names the instance directory on the box, /srv/<instance>
# (DEPLOY.md §11's per-instance table — multiblog, thicketry, ...); its .env is
# where DATABASE_URL, and therefore the db name and credentials, comes from.
# Deliberately just the bare name, not a full /srv/<instance> path: this runs
# under Git Bash on Windows (CLAUDE.md's default shell), whose MSYS layer
# rewrites any CLI argument that *looks like* a POSIX absolute path before
# pwsh.exe ever sees it -- `/srv/thicketry` silently became
# `C:/Program Files/Git/srv/thicketry`. The bare name never matches that
# rewrite pattern, and the real /srv/<instance> path only ever exists inside
# the remote bash command string below, never as a CLI argument.
# -SshHost defaults to deploy@flow. -Force drops and recreates
# frombackup_<db_name> if it already exists locally, rather than stopping.
# -KeepDump leaves the downloaded .sql file in the scratch temp dir instead of
# deleting it after a successful load.
#
# WHAT THIS ASSUMES ABOUT THE LOCAL SIDE
# CLAUDE.md's local Postgres only trusts the `multiblog` role against the
# `multiblog` database specifically -- every other role, and every other
# database, needs a password (that's the whole point of the trust entry being
# scoped that narrowly). Creating a NEW database is exactly the "every other
# database" case, so this needs a role that can CREATEDB -- -LocalPgUser
# defaults to `postgres`. createdb/psql/dropdb will prompt for its password
# interactively if pg_hba.conf doesn't trust it; that's expected and fine when
# you're running this by hand in a real terminal.
#
# WHAT NEVER LEAVES THE REMOTE BOX UNENCRYPTED, AND WHAT DOES
# DATABASE_URL (with its password) is read over the existing SSH connection
# and never written to disk anywhere -- pg_dump on the remote side is handed
# the connection string as an argument within the same ssh invocation, not
# sourced from a file this script downloads. Only the DUMPED DATA leaves the
# box, via scp (also SSH-encrypted), as a plain-SQL file that briefly touches
# local disk before being loaded and (unless -KeepDump) deleted.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Instance,
    [string]$SshHost = 'deploy@flow',
    [string]$LocalPgUser = 'postgres',
    [string]$LocalPgHost = '127.0.0.1',
    [switch]$Force,
    [switch]$KeepDump
)

$ErrorActionPreference = 'Stop'

function Assert-Success([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$what failed (exit $LASTEXITCODE)."
        exit 1
    }
}

# Bare instance name only -- see the -Instance comment above for why a full
# /srv/<instance> path can't be taken as a parameter here at all.
if ($Instance -notmatch '^[\w.-]+$') {
    Write-Error "-Instance must be a bare directory name under /srv, e.g. 'thicketry' (got '$Instance')."
    exit 1
}
$remoteEnvPath = "/srv/$Instance/.env"

foreach ($tool in 'ssh', 'scp', 'psql', 'createdb', 'dropdb') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "'$tool' isn't on PATH -- install the Postgres client tools / an SSH client locally first."
        exit 1
    }
}

# ---- 1. Read DATABASE_URL off the box, purely to name things locally -------
# Not used to build the pg_dump command below -- that sources the .env fresh
# in its own ssh call, so a value quoted differently than this regex expects
# only breaks naming here, never the actual dump.
Write-Host "Reading DATABASE_URL from ${SshHost}:${remoteEnvPath}..."
$envLine = & ssh $SshHost "grep -E '^DATABASE_URL=' '$remoteEnvPath'"
Assert-Success "Reading $remoteEnvPath"
if (-not $envLine) {
    Write-Error "No DATABASE_URL line found in $remoteEnvPath."
    exit 1
}

# postgresql://user:pw@host:port/dbname?params -- dbname is everything after
# the last / up to a ? or the closing quote, same shape DEPLOY.md §3/§4 uses.
if ($envLine -notmatch '://[^/]+/([\w.-]+)') {
    Write-Error "Couldn't parse a database name out of: $envLine"
    exit 1
}
$dbName = $Matches[1]
$localDbName = "frombackup_$dbName"
Write-Host "Remote database: $dbName  ->  local database: $localDbName"

# ---- 2. Dump on the remote box, using its own .env -------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$remoteDumpPath = "/tmp/$dbName-backup-$stamp.sql"

# `. '<envfile>'` (POSIX source) inside `set -a ... set +a` exports every
# assignment the file makes, DATABASE_URL included, for exactly this one
# command -- nothing is written back to the file or left exported in the
# deploy user's shell afterward. Bash's own comment rule (# only starts a
# comment at the start of a token, i.e. after whitespace or another quote) is
# what makes this tolerant of the trailing-comment shape that broke systemd's
# EnvironmentFile= parsing (src/app/sign-in/NOTES.md-adjacent CLAUDE.md entry)
# -- a bug in that file would misbehave the same way here regardless, but this
# specific failure mode is bash-safe.
#
# pg_dump takes a libpq connection URI directly as its dbname argument, so no
# separate -h/-U/-d flags are needed -- one fewer place for the parsed pieces
# to disagree with what's actually in the URL. --no-owner/--no-privileges:
# the remote role won't exist locally, and GRANT/OWNER statements referencing
# it would just fail on load.
#
# DATABASE_URL always carries a trailing `?schema=public` (DEPLOY.md §3/§4) --
# that's a Prisma convention, not a real libpq URI parameter, so pg_dump
# rejects it outright ("invalid URI query parameter: schema") rather than
# ignoring it. `${DATABASE_URL%%\?*}` (bash's longest-match suffix strip)
# drops everything from the first `?` onward before the URL ever reaches
# pg_dump; Postgres defaults to the public schema anyway, which is the only
# one this app uses.
$q = '"'
$bashCmd = "set -a; . '$remoteEnvPath'; set +a; " +
           "pg_dump $q`${DATABASE_URL%%\?*}$q --no-owner --no-privileges -f '$remoteDumpPath' && echo DUMP_OK"

Write-Host "`nDumping $dbName on $SshHost..."
$result = & ssh $SshHost $bashCmd
Assert-Success "Remote pg_dump"
if ($result -notcontains 'DUMP_OK') {
    Write-Error "pg_dump did not report success. Output: $result"
    exit 1
}

# ---- 3. Copy it down ---------------------------------------------------
$localDumpPath = Join-Path $env:TEMP "$dbName-backup-$stamp.sql"
Write-Host "Copying to $localDumpPath..."
& scp -q -- "${SshHost}:$remoteDumpPath" $localDumpPath
Assert-Success "scp"

Write-Host "Removing remote dump ($remoteDumpPath)..."
& ssh $SshHost "rm -f '$remoteDumpPath'"
Assert-Success "Remote cleanup"

# The remote box's pg_dump wraps its plain-SQL output in `\restrict <token>` /
# `\unrestrict <token>` psql meta-commands -- a guard, introduced in a
# Postgres security release, against a restore blindly executing dangerous
# meta-commands from an untrusted dump. It's a pure psql-side toggle with no
# effect on the SQL itself; a psql build that predates it (as the local
# CLAUDE.md-documented Postgres 14 install may well be) doesn't recognize the
# command and aborts on line 1 or so of the load -- which is exactly the
# failure this strips out. Safe here specifically because this script both
# produced the dump and is the only thing loading it, into a database it just
# created for that purpose -- the untrusted-input threat this guards against
# doesn't apply to a dump of your own data restored by the same script.
#
# Also strips `SET transaction_timeout = ...;` -- one line from pg_dump's
# standard preamble (alongside statement_timeout, lock_timeout,
# client_encoding, standard_conforming_strings, ...), and the one line in it
# a Postgres 14 server doesn't recognize: transaction_timeout is a GUC that
# didn't exist before Postgres 17, so `SET transaction_timeout = 0;` aborts
# the whole load with "unrecognized configuration parameter" on an older
# server. Narrowly targeted to that one line and NOT the preamble in
# general -- unlike \restrict, most of the preamble genuinely matters: dropping
# client_encoding or standard_conforming_strings would change how the very
# next statements' text and byte literals are interpreted (the Yjs `bytea`
# blobs and any Unicode text among them), which could corrupt data rather than
# just relax a session timeout that Postgres 14 never had to begin with.
# If a future Postgres version adds another preamble GUC this old a server
# doesn't know, add its own narrow pattern here the same way -- the durable
# fix is updating local Postgres (CLAUDE.md notes that needs an elevated shell
# to restart the service), this is a stopgap for pulling data without one.
Write-Host "Stripping psql's \restrict/\unrestrict guards and the PG17-only transaction_timeout preamble line..."
$filteredDumpPath = "$localDumpPath.filtered"
$reader = [System.IO.StreamReader]::new($localDumpPath)
$writer = [System.IO.StreamWriter]::new($filteredDumpPath)
try {
    while ($null -ne ($line = $reader.ReadLine())) {
        $skip = $line -match '^\\(un)?restrict\b' -or $line -match '^SET\s+transaction_timeout\b'
        if (-not $skip) {
            $writer.WriteLine($line)
        }
    }
} finally {
    $reader.Close()
    $writer.Close()
}
Remove-Item $localDumpPath -Force
Rename-Item $filteredDumpPath $localDumpPath

# ---- 4. (Re)create the local database ------------------------------------
$exists = & psql -U $LocalPgUser -h $LocalPgHost -tAc `
    "SELECT 1 FROM pg_database WHERE datname = '$localDbName'" postgres
Assert-Success "Checking for an existing local $localDbName"

if ($exists -eq '1') {
    if (-not $Force) {
        Write-Error "$localDbName already exists locally. Re-run with -Force to drop and replace it."
        exit 1
    }
    Write-Host "Dropping existing local $localDbName (-Force)..."
    & dropdb -U $LocalPgUser -h $LocalPgHost $localDbName
    Assert-Success "dropdb"
}

Write-Host "Creating local $localDbName..."
& createdb -U $LocalPgUser -h $LocalPgHost $localDbName
Assert-Success "createdb"

# ---- 5. Load it -----------------------------------------------------------
Write-Host "Loading dump into $localDbName..."
& psql -U $LocalPgUser -h $LocalPgHost -d $localDbName -f $localDumpPath -v ON_ERROR_STOP=1 | Out-Null
Assert-Success "Loading the dump"

if ($KeepDump) {
    Write-Host "`nDone. Dump kept at $localDumpPath."
} else {
    Remove-Item $localDumpPath -Force
    Write-Host "`nDone. $localDbName is loaded; the dump file was deleted (-KeepDump to keep it)."
}

Write-Host "`nConnect with: psql -U $LocalPgUser -h $LocalPgHost -d $localDbName"
