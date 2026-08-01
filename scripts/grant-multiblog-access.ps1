# Gives the local `multiblog` role full access to a database this box didn't
# create it for -- specifically the frombackup_<name> databases
# pull-remote-db.ps1 loads, which it necessarily creates under -LocalPgUser
# (default `postgres`), not under `multiblog`.
#
# Usage:
#   pwsh -NoProfile -File scripts/grant-multiblog-access.ps1 -Instance thicketry
#   pwsh -NoProfile -File scripts/grant-multiblog-access.ps1 -Database some_other_db
#     [-AdminPgUser postgres] [-LocalPgHost 127.0.0.1] [-GrantRole multiblog]
#
# -Instance names a pull-remote-db.ps1 backup by its instance name (resolves
# to frombackup_<instance>, same naming that script uses); -Database names any
# other local database directly. Exactly one of the two is required.
# -AdminPgUser is the role that runs the ALTER/GRANT statements below -- it
# needs to be a superuser (or otherwise own everything already), which
# `postgres` is on a normal local install; it does NOT need to already own the
# specific objects (see the REASSIGN OWNED note below for why that would
# actually be the wrong assumption to build on).
#
# "FULL ACCESS" MEANS OWNERSHIP, NOT A PILE OF GRANT ALL STATEMENTS
# GRANT ALL PRIVILEGES on a table gets you SELECT/INSERT/UPDATE/DELETE/
# TRUNCATE/REFERENCES/TRIGGER -- but not DROP or ALTER, which Postgres only
# ever gives the owner (or a superuser), never a grant. If "full access"
# includes being able to drop a table or alter a column while poking at a
# pulled-down copy, ownership is the only primitive that actually gets there,
# so this transfers it outright: ALTER DATABASE/SCHEMA OWNER TO for the two
# container objects, then a DO block ALTER TABLE/SEQUENCE/VIEW OWNER TO-ing
# every object in the public schema individually.
#
# NOT REASSIGN OWNED BY -- IT REFUSES THE COMMON CASE HERE
# `REASSIGN OWNED BY <admin> TO <role>` looks like the one-statement version
# of the DO block above, and was the first thing tried -- confirmed against a
# real local database rather than assumed. It fails whenever -AdminPgUser is
# the cluster's BOOTSTRAP superuser (the role initdb created, `postgres` on
# an ordinary install and therefore this script's default):
#   ERROR: cannot reassign ownership of objects owned by role postgres
#          because they are required by the database system
# Postgres refuses to reassign anything *away from* that specific role,
# clusterwide, regardless of database -- a restriction with nothing to do with
# what the objects actually are (pull-remote-db.ps1's dump loads with
# --no-owner, so there's nothing special about them). Per-object ALTER ...
# OWNER TO has no such restriction and is what's used instead. Confirmed:
# a REASSIGN OWNED BY postgres run inside a single multi-statement `psql -c`
# batch rolled the WHOLE batch back on that error, including statements before
# it that had already succeeded -- Postgres runs an unwrapped multi-statement
# string as one implicit transaction, so this fails atomically rather than
# leaving a half-migrated database, which is worth knowing either way.
#
# WHAT THIS DOES NOT DO: AUTHENTICATION
# CLAUDE.md's local pg_hba.conf trusts the `multiblog` role only against the
# `multiblog` database by name -- that scoping is deliberate (every other
# role+database pair still needs a password) and this script doesn't touch
# it. Owning frombackup_thicketry doesn't make `multiblog` trusted to connect
# to it: `psql -U multiblog -d frombackup_thicketry` will still prompt for
# (or fail without) a password unless that role has one set, or pg_hba is
# edited separately. Privileges and authentication are orthogonal in Postgres;
# this script is only the former.

[CmdletBinding()]
param(
    [string]$Instance,
    [string]$Database,
    [string]$AdminPgUser = 'postgres',
    [string]$LocalPgHost = '127.0.0.1',
    [string]$GrantRole = 'multiblog'
)

$ErrorActionPreference = 'Stop'

function Assert-Success([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$what failed (exit $LASTEXITCODE)."
        exit 1
    }
}

if ([string]::IsNullOrWhiteSpace($Instance) -eq [string]::IsNullOrWhiteSpace($Database)) {
    Write-Error "Pass exactly one of -Instance <name> or -Database <name>."
    exit 1
}

if ($Instance) {
    if ($Instance -notmatch '^[\w.-]+$') {
        Write-Error "-Instance must be a bare name, e.g. 'thicketry' (got '$Instance')."
        exit 1
    }
    $targetDb = "frombackup_$Instance"
} else {
    if ($Database -notmatch '^[\w.-]+$') {
        Write-Error "-Database must be a bare database name (got '$Database')."
        exit 1
    }
    $targetDb = $Database
}

foreach ($tool in 'psql') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Error "'$tool' isn't on PATH."
        exit 1
    }
}

$exists = & psql -U $AdminPgUser -h $LocalPgHost -tAc `
    "SELECT 1 FROM pg_database WHERE datname = '$targetDb'" postgres
Assert-Success "Checking for local database $targetDb"
if ($exists -ne '1') {
    Write-Error "No local database named '$targetDb'. (pull-remote-db.ps1 -Instance <name> creates frombackup_<name>.)"
    exit 1
}

# Identifiers (db/schema/role names) are interpolated, not parameterized --
# psql -c has no bind-parameter mechanism for DDL. Every value here comes from
# a regex-validated CLI argument above or a literal, never from data inside
# the database, so this isn't the SQL-injection-from-untrusted-input shape;
# double-quoting still protects against a name needing quoting (mixed case,
# a reserved word) the way DEPLOY.md's mixed-case-database-name note covers.
Write-Host "Transferring ownership of '$targetDb' to '$GrantRole'..."

& psql -U $AdminPgUser -h $LocalPgHost -v ON_ERROR_STOP=1 -c `
    "ALTER DATABASE `"$targetDb`" OWNER TO `"$GrantRole`";" postgres
Assert-Success "ALTER DATABASE OWNER"

# Reassigns tables, sequences, and views -- not functions. This app's schema
# (prisma/schema.prisma) defines none, so there's nothing to miss today; if
# that ever changes, add a fourth loop over pg_proc/information_schema.routines
# (ALTER FUNCTION needs the full argument-type signature to disambiguate
# overloads, which is why it isn't just a fourth copy-pasted line here).
#
# Single-quoted here-string (@' ... '@): no PowerShell interpolation, which
# matters here specifically because `$do$`-style dollar-quoting is standard
# Postgres syntax for a function/DO body and PowerShell's `$do$` would
# otherwise try to expand a variable named `do`. __GRANT_ROLE__/__TARGET_DB__
# are substituted afterward via a plain string .Replace() -- safe because both
# were already validated against ^[\w.-]+$ above, so neither can contain a
# quote character that would let the replacement escape the SQL string
# literal it lands inside.
$sqlTemplate = @'
ALTER SCHEMA public OWNER TO "__GRANT_ROLE__";

DO $reassign$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO %I', r.tablename, '__GRANT_ROLE__');
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO %I', r.sequencename, '__GRANT_ROLE__');
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO %I', r.viewname, '__GRANT_ROLE__');
  END LOOP;
END
$reassign$;

GRANT ALL PRIVILEGES ON DATABASE "__TARGET_DB__" TO "__GRANT_ROLE__";
GRANT ALL PRIVILEGES ON SCHEMA public TO "__GRANT_ROLE__";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "__GRANT_ROLE__";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "__GRANT_ROLE__";
'@

$sql = $sqlTemplate.Replace('__GRANT_ROLE__', $GrantRole).Replace('__TARGET_DB__', $targetDb)

& psql -U $AdminPgUser -h $LocalPgHost -d $targetDb -v ON_ERROR_STOP=1 -c $sql
Assert-Success "Granting access inside $targetDb"

Write-Host "`nDone. '$GrantRole' now owns '$targetDb', its public schema, and everything in it."
Write-Host "`nNote: this changed PRIVILEGES only, not AUTHENTICATION. CLAUDE.md's local"
Write-Host "pg_hba.conf trusts '$GrantRole' against the 'multiblog' database specifically --"
Write-Host "connecting to '$targetDb' as '$GrantRole' may still need a password:"
Write-Host "  psql -U $GrantRole -h $LocalPgHost -d $targetDb"
