#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Stand up a COMPLETELY NEW MultiBlog instance on a box that already has the
# host-level pieces (Node 24, Postgres, nginx, certbot, ufw, swap — DEPLOY.md
# §2). This is DEPLOY.md §3-§8 carried out in one pass, and it coexists
# happily with any number of MultiBlog instances already on the machine.
#
# Unlike unchurch-dev-install.sh, this derives NOTHING from an existing
# install: there is no live .env to inherit a DB role, password or site title
# from. Everything comes from the configuration block below.
#
# PORTS ARE CHOSEN AUTOMATICALLY. `ss -ltn` is scanned for what is currently
# listening, and the first free TCP port at or above WEB_PORT_FROM (3000) and
# COLLAB_PORT_FROM (1234) is taken. See the PORT SELECTION note further down
# for the one case ss alone gets wrong, and what this does about it.
#
# EDIT THE CONFIGURATION BLOCK BELOW, THEN RUN IT. It takes no arguments.
#
#   chmod +x new-instance-install.sh
#   ./new-instance-install.sh
#
# RUN IT AS THE SERVICE ACCOUNT (the unprivileged user the units will run as,
# conventionally `deploy`) — not as root. It prompts for the sudo password.
#
# PREREQUISITE IT CANNOT DO FOR YOU: a DNS A record (and AAAA, if you use
# IPv6) for APP_HOST pointing at this box. certbot's HTTP-01 challenge needs
# it, and the preflight refuses to continue without it.
#
# Safe to re-run after a failure: it detects its own partial work and resumes
# rather than redoing it (see RESUME below). To start over completely, see the
# "Rolling this back" block at the bottom of the file.
# ---------------------------------------------------------------------------
set -euo pipefail

# ======================= CONFIGURATION — EDIT THIS =========================

# ---- what to deploy -------------------------------------------------------
APP_HOST=blog.example.com                        # the public hostname; needs DNS + a cert
APP_DIR=/srv/myblog                              # clone lives here; also names the units
NEXT_PUBLIC_SITE_TITLE="My Blog"                 # site title (src/lib/site-config.ts)
REPO_URL=git@github.com:labreuer/MultiBlog.git
BRANCH=main

# ---- database -------------------------------------------------------------
# A mixed-case or hyphenated name is fine — every identifier is quoted at
# CREATE time (DEPLOY.md §11: an unquoted mixed-case name silently folds to
# lowercase and then "database does not exist" on connect).
DB_NAME=myblog
DB_ROLE=myblog
DB_PASSWORD=""                                   # empty -> generated (openssl rand -hex 24)

# ---- the first admin ------------------------------------------------------
# A fresh database has no users and NOTHING IN THE UI creates the first one,
# so this is not optional (DEPLOY.md §5 step 6). scripts/create-admin.ts is a
# no-op if the address already exists, so re-runs are harmless.
ADMIN_EMAIL=you@example.com
ADMIN_NAME="Your Name"
ADMIN_INITIALS=YN
ADMIN_PASSWORD=""                                # empty -> generated, printed once at the end

# ---- ports ----------------------------------------------------------------
# Starting points only — the first FREE port at or above each is taken.
WEB_PORT_FROM=3000
COLLAB_PORT_FROM=1234

# ---- misc -----------------------------------------------------------------
SERVICE_USER="$(id -un)"                         # who the units run as; default: you
CERTBOT_EMAIL=""                                 # set to run certbot non-interactively
                                                 # on a box with no certbot account yet
# V8 sizes its heap ceiling from physical RAM and ignores swap, so on a 1 GB
# Nanode the default is too low to finish `next build` (DEPLOY.md §2h).
BUILD_HEAP_MB=3072

SKIP_DNS_CHECK=${SKIP_DNS_CHECK:-0}
SCAN_DECLARED_PORTS=${SCAN_DECLARED_PORTS:-1}    # see PORT SELECTION below
ASSUME_YES=${ASSUME_YES:-0}

# ===================== end of configuration ================================

INSTANCE="$(basename "$APP_DIR")"                # myblog
WEB_UNIT="${INSTANCE}-web"                       # myblog-web      (bare: see note at §7)
COLLAB_UNIT="${INSTANCE}-collab"                 # myblog-collab

# -------------------------------- helpers ----------------------------------
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[1;33mWARNING:\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mABORT:\033[0m %s\n\n' "$*" >&2; exit 1; }

keepsudo() { sudo -v; }

confirm() {
    if [ "$ASSUME_YES" = 1 ]; then return 0; fi
    local reply
    read -r -p "$1 [y/N] " reply
    case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) die "Cancelled." ;; esac
}

# Last assignment of KEY in FILE, one layer of surrounding quotes removed.
# Anchored, so `PORT` never matches `COLLAB_PORT`.
envget() {
    local key=$1 file=$2 line
    line=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n 1 || true)
    [ -n "$line" ] || return 1
    line=${line#*=}
    printf '%s' "$line" | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

mask_url() { printf '%s' "$1" | sed -E 's#:[^:@/]+@#:****@#'; }

db_exists() {
    [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]
}
role_exists() {
    [ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = "1" ]
}

# /etc/letsencrypt/live/<host>/ is root-only (0700) — a plain `[ -f ... ]` as
# the service account can't even traverse into it and reports "missing"
# whether or not the cert exists, which reads exactly like certbot silently
# failing. Needs sudo to mean anything.
cert_exists() { sudo test -f "/etc/letsencrypt/live/$1/fullchain.pem"; }

# =========================== 1. preflight ==================================
say "Preflight"

[ "$(id -u)" -ne 0 ] || die "Run this as the unprivileged service account (conventionally 'deploy'), not as root — the clone and build must be owned by the user the systemd units run as."
command -v sudo >/dev/null || die "sudo is not installed."
keepsudo

for tool in git node npm nginx psql ss openssl curl awk sed; do
    command -v "$tool" >/dev/null || die "'$tool' is not on PATH."
done

if ! command -v certbot >/dev/null; then
    say "Installing certbot (not present)"
    sudo apt install -y certbot python3-certbot-nginx
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || die "Node $(node -v) is too old; package.json requires >=24 (DEPLOY.md §2d)."

systemctl is-active --quiet postgresql || die "postgresql is not running. Start it (sudo systemctl start postgresql) and re-run."

[ "$(id -un)" = "$SERVICE_USER" ] || die "SERVICE_USER is '$SERVICE_USER' but you are '$(id -un)'. Run this as $SERVICE_USER, or the clone and build end up owned by the wrong user."

case "$APP_HOST" in
    ""|*" "*|blog.example.com) die "Set APP_HOST in the configuration block to this instance's real hostname." ;;
esac
case "$ADMIN_EMAIL" in
    ""|you@example.com) die "Set ADMIN_EMAIL in the configuration block — a fresh database has no users and nothing in the UI creates the first one." ;;
esac
case "$DB_ROLE" in *[!A-Za-z0-9_]*) die "DB_ROLE '$DB_ROLE' has characters this script won't quote correctly in a connection URL. Use letters, digits and underscores." ;; esac
[ -n "$NEXT_PUBLIC_SITE_TITLE" ] || die "NEXT_PUBLIC_SITE_TITLE is empty. Set it (or the site falls back to \"MultiBlog\")."
# The .env in §6 is written from an UNQUOTED heredoc, so a `$` or backtick
# here would be expanded away at write time rather than reaching the file,
# and a double quote would break the KEY="value" line outright.
case "$NEXT_PUBLIC_SITE_TITLE" in
    *'"'*|*'$'*|*'`'*|*'\'*) die "NEXT_PUBLIC_SITE_TITLE must not contain \" \$ \` or a backslash — it is written into a shell heredoc and then into a systemd EnvironmentFile, and would be mangled by both." ;;
esac

# --- resume detection ------------------------------------------------------
# Re-running after a failure is expected; silently adopting an unrelated
# directory that happens to share this name is not. The only thing accepted
# is a git checkout of the shape this script would itself have created.
RESUME=0
if [ -e "$APP_DIR" ]; then
    if [ -d "$APP_DIR/.git" ] && [ -f "$APP_DIR/package.json" ]; then
        RESUME=1
    else
        die "$APP_DIR already exists but isn't a git checkout (no .git/package.json) — doesn't look like a prior run of this script. Remove it, or point APP_DIR elsewhere."
    fi
fi

# A unit file this script wrote is fine to overwrite in §7; a same-named unit
# from anywhere else is a real collision.
for u in "$WEB_UNIT" "$COLLAB_UNIT"; do
    f="/etc/systemd/system/$u.service"
    if [ -e "$f" ] && ! sudo grep -q '# Generated by new-instance-install.sh' "$f" 2>/dev/null; then
        die "$f already exists and wasn't written by this script. Pick a different APP_DIR (it names the units) or resolve the collision by hand."
    fi
done

git ls-remote --heads "$REPO_URL" "$BRANCH" 2>/dev/null | grep -q . \
    || die "Cannot reach '$REPO_URL' branch '$BRANCH' (is this box's SSH key on the GitHub account?). Fix that, or rsync the tree to $APP_DIR by hand and re-run — the clone step is skipped when $APP_DIR is already a checkout."

# --- DNS must already point here, or certbot fails later in the run -------
if [ "$SKIP_DNS_CHECK" != 1 ]; then
    mapfile -t host_ips < <(ip -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | sort -u)
    mapfile -t dns_ips  < <(getent ahosts "$APP_HOST" 2>/dev/null | awk '{print $1}' | sort -u)
    [ "${#dns_ips[@]}" -gt 0 ] || die "$APP_HOST does not resolve. Add an A record (and AAAA if you use IPv6) pointing at this box, wait for it to propagate, then re-run."
    matched=0
    for d in "${dns_ips[@]}"; do
        for h in "${host_ips[@]}"; do [ "$d" = "$h" ] && matched=1; done
    done
    [ "$matched" = 1 ] || die "$APP_HOST resolves to ${dns_ips[*]} but this box has ${host_ips[*]}. certbot's HTTP-01 challenge would fail. (Set SKIP_DNS_CHECK=1 to override, e.g. behind a proxy.)"
fi

# --- swap, since `next build` is the memory peak on a small box -----------
mem_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
swap_mb=$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 2048 ] && [ "$swap_mb" -lt 1024 ]; then
    warn "This box has ${mem_mb} MB RAM and ${swap_mb} MB swap. \`next build\` peaks well above 1 GB and will be OOM-killed partway through with no useful error. Add swap first (DEPLOY.md §2h): sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
    confirm "Continue anyway?"
fi

# =========================== 2. port selection =============================
# PORT SELECTION
# `ss -ltn` is the primary source: it is the ground truth for what is bound
# RIGHT NOW. Its blind spot is a MultiBlog instance that is currently
# STOPPED — its ports look free, and taking them means the two instances can
# never both run. So the ports already DECLARED by other instances' unit
# files and .env files are excluded too, which costs nothing and removes that
# failure entirely. Set SCAN_DECLARED_PORTS=0 to use ss alone.
say "Choosing ports"

mapfile -t BUSY_PORTS < <(ss -ltn 2>/dev/null | tail -n +2 | awk '{print $4}' \
    | sed -E 's/.*:([0-9]+)$/\1/' | { grep -E '^[0-9]+$' || true; } | sort -un || true)
info "listening now: ${#BUSY_PORTS[@]} TCP port(s) — ${BUSY_PORTS[*]:-none}"

RESERVED_PORTS=()
if [ "$SCAN_DECLARED_PORTS" = 1 ]; then
    # Each grep gets its own `|| true`: a no-match exits 1, and under `set -e`
    # (inherited by this subshell) the FIRST one failing would abort the group
    # before the second ever ran — silently scanning only half the sources.
    mapfile -t RESERVED_PORTS < <( {
        { sudo grep -hsE '^Environment=PORT=[0-9]+' /etc/systemd/system/*.service 2>/dev/null || true; } \
            | sed -E 's/.*PORT=([0-9]+).*/\1/'
        { sudo grep -hsE '^[[:space:]]*COLLAB_PORT=' /srv/*/.env 2>/dev/null || true; } \
            | sed -E 's/.*COLLAB_PORT=["'"'"']?([0-9]+).*/\1/'
    } | { grep -E '^[0-9]+$' || true; } | sort -un || true)
    if [ "${#RESERVED_PORTS[@]}" -gt 0 ]; then
        info "declared by other instances (not necessarily listening): ${RESERVED_PORTS[*]}"
    fi
fi

port_taken() { # port_taken PORT [EXTRA_EXCLUDE...]
    local p=$1; shift
    local x
    for x in "${BUSY_PORTS[@]:-}" "${RESERVED_PORTS[@]:-}" "$@"; do
        if [ "$x" = "$p" ]; then return 0; fi
    done
    return 1
}

# Note: no shared mutable state — a `CLAIMED+=()` inside this function would
# be lost, since the caller runs it in a command substitution (subshell).
# Already-chosen ports are passed back in as explicit excludes instead.
pick_port() { # pick_port START [EXTRA_EXCLUDE...]
    local start=$1; shift
    local p=$start
    while [ "$p" -le 65535 ]; do
        if ! port_taken "$p" "$@"; then printf '%s' "$p"; return 0; fi
        p=$((p + 1))
    done
    return 1
}

# On a resume, ports already committed to disk win over a fresh scan — the
# instance's own now-running services would otherwise look like a collision
# and push the next run onto different ports than its nginx config names.
WEB_PORT=""
COLLAB_PORT=""
if [ -f "/etc/systemd/system/$WEB_UNIT.service" ]; then
    WEB_PORT=$(sudo sed -n -E 's/^Environment=PORT=([0-9]+).*/\1/p' "/etc/systemd/system/$WEB_UNIT.service" | tail -n 1 || true)
    [ -n "$WEB_PORT" ] && info "web port $WEB_PORT reused from the existing $WEB_UNIT.service"
fi
if [ -f "$APP_DIR/.env" ]; then
    COLLAB_PORT=$(envget COLLAB_PORT "$APP_DIR/.env" || true)
    [ -n "$COLLAB_PORT" ] && info "collab port $COLLAB_PORT reused from the existing $APP_DIR/.env"
fi

if [ -z "$WEB_PORT" ]; then
    WEB_PORT=$(pick_port "$WEB_PORT_FROM" "${COLLAB_PORT:-}") \
        || die "No free TCP port at or above $WEB_PORT_FROM."
fi
if [ -z "$COLLAB_PORT" ]; then
    COLLAB_PORT=$(pick_port "$COLLAB_PORT_FROM" "$WEB_PORT") \
        || die "No free TCP port at or above $COLLAB_PORT_FROM."
fi
[ -n "$WEB_PORT" ] && [ -n "$COLLAB_PORT" ] || die "Port selection failed."
[ "$WEB_PORT" != "$COLLAB_PORT" ] || die "Web and collab both resolved to port $WEB_PORT."

# =========================== 3. secrets ====================================
# Generated only when not supplied, and only when there is no .env yet: a
# resume must never mint a new AUTH_SECRET (it also signs the collab JWTs, so
# rotating it invalidates every live editing session) or a new DB password
# (which would no longer match the role that already exists).
GENERATED_DB_PASSWORD=0
GENERATED_ADMIN_PASSWORD=0

if [ -f "$APP_DIR/.env" ]; then
    DB_URL=$(envget DATABASE_URL "$APP_DIR/.env") || die "$APP_DIR/.env exists but has no DATABASE_URL. Delete it to have this script rewrite it, or repair it by hand."
else
    if [ -z "$DB_PASSWORD" ]; then
        if role_exists "$DB_ROLE"; then
            die "Role \"$DB_ROLE\" already exists, so its password cannot be generated here — set DB_PASSWORD in the configuration block to the existing password (or pick a different DB_ROLE)."
        fi
        # Hex: URL-safe by construction. The password is embedded in
        # DATABASE_URL, where @ : / ? # % mis-parse the connection string
        # (DEPLOY.md §3).
        DB_PASSWORD=$(openssl rand -hex 24)
        GENERATED_DB_PASSWORD=1
    fi
    # Enforced for a hand-set password too. This one check is what makes it
    # safe to interpolate the value into a SQL literal (§5), into
    # DATABASE_URL, and into the systemd EnvironmentFile — three different
    # quoting contexts, none of which this charset can escape.
    case "$DB_PASSWORD" in
        *[!A-Za-z0-9._~-]*) die "DB_PASSWORD must use only letters, digits and . _ ~ - — it is embedded in DATABASE_URL, where @ : / ? # % mis-parse the connection string (DEPLOY.md §3). Leave it empty to have one generated." ;;
    esac
    DB_URL="postgresql://${DB_ROLE}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public"
fi

if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD=$(openssl rand -base64 18)
    GENERATED_ADMIN_PASSWORD=1
fi

say "Discovered"
info "service account ..... $SERVICE_USER"
info "node ................ $(node -v)"
info "memory / swap ....... ${mem_mb} MB / ${swap_mb} MB"
[ "$RESUME" = 1 ] && info "mode ................ RESUMING a previous run — already-done steps are skipped, not redone"
echo
say "Will create"
info "directory ........... $APP_DIR   (branch $BRANCH)"
info "hostname ............ https://$APP_HOST   (new Let's Encrypt cert)"
info "site title .......... $NEXT_PUBLIC_SITE_TITLE"
info "database ............ \"$DB_NAME\" owned by role \"$DB_ROLE\""
info "DATABASE_URL ........ $(mask_url "$DB_URL")"
info "web port ............ $WEB_PORT   (first free at or above $WEB_PORT_FROM)"
info "collab port ......... $COLLAB_PORT   (first free at or above $COLLAB_PORT_FROM)"
info "units ............... $WEB_UNIT, $COLLAB_UNIT"
info "first admin ......... $ADMIN_EMAIL ($ADMIN_NAME, $ADMIN_INITIALS)"
if [ "$GENERATED_DB_PASSWORD" = 1 ];    then info "DB password ......... generated — printed once at the end"; fi
if [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then info "admin password ...... generated — printed once at the end"; fi
echo
confirm "Proceed?"

# =========================== 4. clone ======================================
if [ "$RESUME" = 1 ]; then
    say "Reusing existing $APP_DIR (already cloned)"
    info "HEAD: $(git -C "$APP_DIR" log -1 --format='%h %s')"
else
    say "Creating $APP_DIR and cloning $BRANCH"
    sudo mkdir -p "$APP_DIR"
    sudo chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    info "HEAD: $(git -C "$APP_DIR" log -1 --format='%h %s')"
fi

# =========================== 5. role + database ============================
# Production uses a password-protected role — do NOT copy the dev box's
# passwordless `trust` setup (DEPLOY.md §3). Identifiers are quoted so a
# mixed-case name survives (§11).
keepsudo
if role_exists "$DB_ROLE"; then
    say "Role \"$DB_ROLE\" already exists — skipping create"
else
    say "Creating role \"$DB_ROLE\""
    # Interpolated directly, which is safe only because DB_PASSWORD was
    # charset-checked in §3 — no quote, backslash or other character that
    # could break out of the SQL literal can reach here.
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
        -c "CREATE ROLE \"$DB_ROLE\" WITH LOGIN PASSWORD '$DB_PASSWORD';"
fi

if db_exists "$DB_NAME"; then
    say "Database \"$DB_NAME\" already exists — skipping create"
else
    say "Creating database \"$DB_NAME\" (owner $DB_ROLE)"
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres \
        -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_ROLE\";"
fi

# Verify the credentials the app will actually use, before npm ci and a
# multi-minute build are spent on a connection string that turns out to be
# wrong.
#
# NOT with the URL verbatim. `?schema=public` is a PRISMA parameter, and
# psql speaks libpq, which rejects any URI query parameter it doesn't
# recognise — it fails with `invalid URI query parameter: "schema"` during
# URL PARSING, before opening a socket, so a perfectly good password reports
# as a connection failure. (DEPLOY.md §3's own sanity-check command omits the
# query string for the same reason.) Dropping it costs nothing here: this is
# a loopback connection, and `schema` selects a search_path for Prisma rather
# than affecting whether the credentials work.
psql_url() { printf '%s' "$1" | sed -E 's/\?.*$//'; }

say "Verifying the connection string"
if ! verify_out=$(psql "$(psql_url "$DB_URL")" -tAc 'SELECT 1' 2>&1); then
    die "Could not connect as role \"$DB_ROLE\" to database \"$DB_NAME\" on 127.0.0.1:5432.
         psql said: ${verify_out}
         If the role pre-existed, DB_PASSWORD in the configuration block doesn't match it."
fi
info "connected OK"

# =========================== 6. .env =======================================
# Skipped wholesale if it already exists: re-running would mint a new
# AUTH_SECRET, which also signs the collab JWTs (src/lib/collab-token.ts) and
# must stay identical between the web and collab units.
if [ -f "$APP_DIR/.env" ]; then
    say "$APP_DIR/.env already exists — leaving it as-is (not regenerating AUTH_SECRET)"
else
    say "Writing $APP_DIR/.env"
    # No inline `#` comments: systemd's EnvironmentFile parser folds them into
    # the value (DEPLOY.md §4).
    cat > "$APP_DIR/.env" <<EOF
DATABASE_URL="$DB_URL"
AUTH_SECRET="$(openssl rand -base64 32)"
AUTH_TRUST_HOST="true"
AUTH_URL="https://$APP_HOST"
APP_URL="https://$APP_HOST"
COLLAB_PORT="$COLLAB_PORT"
NEXT_PUBLIC_COLLAB_URL="wss://$APP_HOST/collab"
NEXT_PUBLIC_SITE_TITLE="$NEXT_PUBLIC_SITE_TITLE"
EOF
    chmod 600 "$APP_DIR/.env"
    info "$(grep -c . "$APP_DIR/.env") lines, mode 600"
fi

# =========================== 7. deps + schema + admin ======================
# Full install, not --omit=dev: prisma, tsx and typescript are runtime here —
# tsx is what actually executes the collab server (DEPLOY.md §5).
say "npm ci"
cd "$APP_DIR"
npm ci

say "prisma generate"
npx prisma generate

say "prisma migrate deploy"
npx prisma migrate deploy

# create-admin.ts (not test-user.ts, which refuses anything but @example.com)
# is a no-op when the address already exists, so a resume re-runs it safely.
say "Seeding the first admin ($ADMIN_EMAIL)"
npx tsx scripts/create-admin.ts "$ADMIN_EMAIL" "$ADMIN_NAME" "$ADMIN_INITIALS" "$ADMIN_PASSWORD"

# =========================== 8. nginx bootstrap + cert =====================
NGINX_SITE="/etc/nginx/sites-available/$INSTANCE"

keepsudo
if cert_exists "$APP_HOST"; then
    say "Certificate for $APP_HOST already exists — skipping certbot"
else
    # HTTP-only block first: the 443 block below references cert files that do
    # not exist yet, so enabling it now would make `nginx -t` fail and nginx
    # refuse to start (DEPLOY.md §7a).
    #
    # `listen [::]:80` is not optional. On a box with more than one site, a
    # block missing it has no IPv6 listener of its own, and IPv6 traffic for
    # this host silently falls through to whichever OTHER block claims
    # [::]:80 — which surfaces as certbot's challenge 404ing via that other
    # site's redirect-to-https, with this block's server_name looking
    # completely correct.
    say "Bootstrapping nginx on :80 for $APP_HOST (so certbot can answer the challenge)"
    sudo tee "$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $APP_HOST;
    root /var/www/html;
}
EOF
    sudo ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/$INSTANCE"
    # Only on a truly first deploy: the stock default site's default_server
    # would otherwise shadow this one (DEPLOY.md §7a). Left alone if another
    # real site is already enabled here.
    if [ -e /etc/nginx/sites-enabled/default ] && [ "$(ls -1 /etc/nginx/sites-enabled | wc -l)" -le 2 ]; then
        info "removing the stock default site so it can't shadow this one"
        sudo rm -f /etc/nginx/sites-enabled/default
    fi
    sudo nginx -t && sudo systemctl reload nginx

    say "Issuing the certificate for $APP_HOST"
    if [ -n "$CERTBOT_EMAIL" ]; then
        sudo certbot certonly --nginx -d "$APP_HOST" --non-interactive --agree-tos -m "$CERTBOT_EMAIL"
    else
        sudo certbot certonly --nginx -d "$APP_HOST"
    fi
    cert_exists "$APP_HOST" || die "certbot did not produce /etc/letsencrypt/live/$APP_HOST/fullchain.pem."

    # Make renewals actually reload nginx (DEPLOY.md §7a). Harmless to rewrite
    # if another instance already put it there. mkdir -p because the hook
    # directory doesn't exist yet on a box where certbot was only just
    # installed above.
    sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    echo 'systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
    sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi

# =========================== 9. nginx real config ==========================
# Mirrors deploy/nginx-app.conf.sample with this instance's host and ports.
# Every $-prefixed name below is an *nginx* variable, hence the backslashes.
say "Installing the full nginx config for $APP_HOST -> :$WEB_PORT / :$COLLAB_PORT"
keepsudo
sudo tee "$NGINX_SITE" >/dev/null <<EOF
# MultiBlog ($INSTANCE) — generated by new-instance-install.sh.
# App at /, Hocuspocus collab websocket at /collab. See DEPLOY.md §7.

server {
    listen 80;
    listen [::]:80;
    server_name $APP_HOST;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $APP_HOST;

    ssl_certificate     /etc/letsencrypt/live/$APP_HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$APP_HOST/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The document id travels in-band, not in the URL, so /collab is proxied
    # untouched — no prefix rewrite.
    location /collab {
        proxy_pass http://127.0.0.1:$COLLAB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
sudo ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/$INSTANCE"
sudo nginx -t && sudo systemctl reload nginx

# =========================== 10. build =====================================
# Must precede starting the web unit (`next start` needs .next), and must
# follow §6: NEXT_PUBLIC_COLLAB_URL and NEXT_PUBLIC_SITE_TITLE are inlined
# into the client bundle at build time, not read at runtime (DEPLOY.md §4).
say "Building (NODE_OPTIONS=--max-old-space-size=$BUILD_HEAP_MB)"
cd "$APP_DIR"
time NODE_OPTIONS="--max-old-space-size=$BUILD_HEAP_MB" npm run build

# =========================== 11. systemd ===================================
# The unit FILES need the .service suffix; the unit NAMES passed to systemctl
# and written into the sudoers grant stay bare, because that is what
# deploy/deploy.sh's own `sudo systemctl restart "$WEB_UNIT"` sends and the
# NOPASSWD rule has to match it verbatim.
say "Installing $WEB_UNIT and $COLLAB_UNIT"
keepsudo
sudo tee "/etc/systemd/system/$WEB_UNIT.service" >/dev/null <<EOF
# Generated by new-instance-install.sh. See DEPLOY.md §6.
[Unit]
Description=MultiBlog Next.js app ($INSTANCE)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
Environment=PORT=$WEB_PORT
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo tee "/etc/systemd/system/$COLLAB_UNIT.service" >/dev/null <<EOF
# Generated by new-instance-install.sh. See DEPLOY.md §6.
# collab:prod, not collab: the dev script is \`tsx watch\` and would restart on
# every file change.
[Unit]
Description=MultiBlog Hocuspocus collab server ($INSTANCE)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run collab:prod
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# NOPASSWD for exactly these two units, so deploy/deploy.sh can restart them
# non-interactively. Both /usr/bin and /bin spellings: sudoers matches the
# literal path, and `sudo systemctl` resolves through PATH.
say "Granting NOPASSWD restart for $WEB_UNIT / $COLLAB_UNIT"
sudo tee "/etc/sudoers.d/$INSTANCE" >/dev/null <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $WEB_UNIT $COLLAB_UNIT, /bin/systemctl restart $WEB_UNIT $COLLAB_UNIT
EOF
sudo visudo -cf "/etc/sudoers.d/$INSTANCE" || { sudo rm -f "/etc/sudoers.d/$INSTANCE"; die "Generated sudoers file failed validation and was removed."; }
sudo chmod 440 "/etc/sudoers.d/$INSTANCE"

sudo systemctl daemon-reload
sudo systemctl enable --now "$WEB_UNIT" "$COLLAB_UNIT"

# =========================== 12. verify ====================================
say "Verifying"
for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "https://$APP_HOST/" && break
    sleep 2
done
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$APP_HOST/" || true)
info "https://$APP_HOST/ -> HTTP $code"
systemctl --no-pager status "$WEB_UNIT" "$COLLAB_UNIT" | sed -n '1,12p'
[ "$code" = "200" ] || warn "The site did not answer 200. Check: journalctl -u $WEB_UNIT -n 80"

cat <<EOF

────────────────────────────────────────────────────────────────────────────
$INSTANCE is up at https://$APP_HOST — "$NEXT_PUBLIC_SITE_TITLE"

  directory   $APP_DIR
  database    "$DB_NAME"  (role "$DB_ROLE")
  ports       web $WEB_PORT, collab $COLLAB_PORT
  units       $WEB_UNIT, $COLLAB_UNIT
  admin       $ADMIN_EMAIL
EOF

if [ "$GENERATED_DB_PASSWORD" = 1 ] || [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then
    printf '\n  \033[1mGENERATED SECRETS — SHOWN ONCE, SAVE THEM NOW\033[0m\n'
    if [ "$GENERATED_DB_PASSWORD" = 1 ]; then
        printf '    postgres role "%s": %s\n' "$DB_ROLE" "$DB_PASSWORD"
        printf '      (also inside %s/.env, mode 600)\n' "$APP_DIR"
    fi
    if [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then
        printf '    admin %s: %s\n' "$ADMIN_EMAIL" "$ADMIN_PASSWORD"
        printf '      (change it after first sign-in; nothing else records it)\n'
    fi
fi

cat <<EOF

Check, in this order:
  1. curl -sI https://$APP_HOST/                  -> 200
  2. sign in as $ADMIN_EMAIL
  3. publish a post and load its public /<slug>. Do this one specifically: it
     is the statically-generated page class, and a server exception there
     renders a generic error page while the unit stays 'active' — so
     journalctl -u $WEB_UNIT is the check, not the status line.
  4. open a doc and type — status must go 🟢 Live, which is what proves
     wss://$APP_HOST/collab reaches :$COLLAB_PORT through nginx.

Future deploys need no arguments — deploy/deploy.sh derives its unit names
from the directory:  cd $APP_DIR && ./deploy/deploy.sh

Still worth doing by hand (DEPLOY.md §9): a daily pg_dump of "$DB_NAME" off
the box, and one tested restore. An untested backup isn't one.

Rolling this back entirely:
  sudo systemctl disable --now $WEB_UNIT $COLLAB_UNIT
  sudo rm -f /etc/systemd/system/$WEB_UNIT.service /etc/systemd/system/$COLLAB_UNIT.service /etc/sudoers.d/$INSTANCE
  sudo systemctl daemon-reload
  sudo rm -f /etc/nginx/sites-enabled/$INSTANCE /etc/nginx/sites-available/$INSTANCE
  sudo nginx -t && sudo systemctl reload nginx
  sudo certbot delete --cert-name $APP_HOST
  sudo -u postgres dropdb '$DB_NAME' && sudo -u postgres dropuser '$DB_ROLE'
  sudo rm -rf $APP_DIR
────────────────────────────────────────────────────────────────────────────
EOF
