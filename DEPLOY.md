# MultiBlog — Deployment runbook

Concrete, self-managed deployment onto a **fresh Linode running Ubuntu 26.04 LTS**, built
from nothing: OS provisioning, a non-root user, firewall, and installs of Node, Postgres,
and nginx, then the app itself. nginx is the reverse proxy; TLS is a free single-domain
Let's Encrypt cert via certbot (§7a). Collab runs **path-based** under `/collab` on the app
host, so there's just one hostname and one cert. No containers, no external spam service, no
email provider.

Scope of this first deploy: provision the box, stand up two Node services (Next.js app +
Hocuspocus collab) behind nginx, create one Postgres database, apply migrations, seed one
real admin.

---

## 0. Topology

```
                        ┌──────────── Linode (Ubuntu 26.04) ─────────┐
   Internet ── 443 ──▶ nginx ─ /       ─▶ 127.0.0.1:3000  next start  (systemd)│
              (TLS,        │   /collab  ─▶ 127.0.0.1:1234  hocuspocus (systemd) │ (ws upgrade)
          LE certbot)      │                                            │
                           └──▶ 127.0.0.1:5432  postgres (localhost only)┘
```

- App and collab are **separate long-running processes**, each its own systemd unit, both
  proxied under a **single hostname** — the app at `/`, collab at `/collab`.
- Postgres binds to localhost; nothing but nginx (80/443) and SSH (22) is exposed.
- The collab port (1234) is **never** opened on the firewall — nginx proxies WebSocket
  traffic to it. Browsers connect to `wss://<app-host>/collab` and nginx upgrades to the
  local ws. The Hocuspocus document id travels in-band, so the `/collab` path prefix needs
  no rewriting.

---

## 1. Three code/config changes needed *before* the first deploy

These are real gaps in the current tree, not just ops steps. Each is small; do them (on the
`deploy-prep` branch) before building.

### 1a. NextAuth must trust the proxy host

`src/lib/auth.ts` (NextAuth v5) runs behind nginx, so the incoming `Host`/`X-Forwarded-*`
headers come from the proxy. Without `trustHost`, v5 refuses to honor them in production and
sign-in redirects/callbacks break. Set it via env (preferred) — add to the prod `.env`:

```
AUTH_TRUST_HOST=true
AUTH_URL=https://<app-host>        # canonical https origin
```

(Alternatively `trustHost: true` in the `NextAuth({...})` config — env is cleaner so the
same code runs unchanged in dev.)

### 1b. A production start command for the collab server

`npm run collab` is `tsx watch server/collab.ts` — dev-only (file watching, restarts on
change). Production should run it once, no watcher. Add to `package.json`:

```json
"collab:prod": "tsx server/collab.ts"
```

The systemd unit (§6) invokes this. `tsx` is a runtime dependency here (it's what runs the
TS collab entrypoint), so it stays installed on the server — do **not** prune devDeps below
what `collab:prod` needs (see §5 note).

### 1c. A way to create the real admin

`scripts/test-user.ts` refuses anything but `@example.com`, so it can't create
`labreuer@gmail.com`. A fresh prod DB has **no users** and nothing in the UI creates the
first admin. A `User` needs `email`, `slug`, `adminInitials`, `passwordHash`, and
`role = ADMIN` set explicitly (the rest default). Add a tiny one-off, e.g.
`scripts/create-admin.ts`, run once with `npx tsx` on the server:

```
npx tsx scripts/create-admin.ts <email> <name> <adminInitials> <password>
```

It should `bcrypt.hash` the password, generate a unique slug (reuse `uniqueUserSlug`), and
insert with `role: "ADMIN"`. Guard on existing email so a re-run is a harmless no-op.

---

## 2. Provision the Linode from scratch

### 2a. Create the instance

- **Image: Ubuntu 26.04 LTS.** If Linode's image list doesn't offer it yet, or its default
  Node is older than 20 (checked in §2d), fall back to **24.04 LTS** — every step below works
  unchanged on 24.04.
- Plan: a **1 GB Nanode** is fine at runtime (the two Node services + Postgres are light),
  but 1 GB is not enough for `next build` — you **must** add swap (§2h) or the build gets
  OOM-killed. Add SSH keys during creation if you can.
- Point DNS: an `A`/`AAAA` record for `<app-host>` at the Linode's IP. (Just the one name —
  collab shares this host under `/collab`, §7.)

### 2b. Initial setup & hardening

SSH in as `root` first, then:

```bash
apt update && apt upgrade -y
timedatectl set-timezone UTC            # or your zone

# non-root deploy user with sudo
adduser deploy                          # set a password
usermod -aG sudo deploy

# give it your SSH key
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/    # or paste your pubkey in
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
```

Then harden SSH — edit `/etc/ssh/sshd_config` (or a drop-in in `/etc/ssh/sshd_config.d/`):

```
PermitRootLogin no
PasswordAuthentication no
```

`sudo systemctl restart ssh`. **Confirm you can log in as `deploy` in a new session before
closing the root one.** Everything from here runs as `deploy` with `sudo`.

### 2c. Firewall

```bash
sudo ufw allow OpenSSH        # 22
sudo ufw allow 'Nginx Full'   # 80 + 443  (available after nginx is installed in 2f;
                              # or: sudo ufw allow 80,443/tcp)
sudo ufw enable
sudo ufw status
```

Do **not** open 1234 or 5432 — both stay localhost-only behind nginx / the loopback.

### 2d. Install Node 20+

A brand-new LTS ships a recent Node in its own repo, and the distro package is system-wide
(`/usr/bin`, which is what the systemd units in §6 expect). Check it first:

```bash
apt-cache policy nodejs
```

- **If the candidate is ≥ 20:** `sudo apt install -y nodejs npm`, then verify `node -v` and
  `npm -v`.
  > **Confirmed on 26.04: `nodejs` and `npm` are independently-versioned apt packages, and
  > `npm` lags badly** — `nodejs` at 22.22.1 pairs with `npm` 9.2.0, when Node 22 should
  > bundle npm ~10.9.x. `/usr/bin/npm` is still the right binary (no PATH-shadowing — `/bin`
  > is the merged-usr symlink to `/usr/bin`), it's just stale. Fix it in place:
  > ```bash
  > sudo npm install -g npm@10
  > hash -r
  > npm -v      # expect 10.x
  > ```
- **If it's older, or 26.04's repo Node is missing:** install NodeSource's Node 22 LTS *if it
  publishes a 26.04 repo* (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -`
  then `sudo apt install -y nodejs`). NodeSource often lags a just-released LTS — if it 404s
  on the 26.04 codename, use **nvm** instead:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # re-open the shell, then:
  nvm install --lts    # 22.x
  ```
  > **nvm caveat for systemd:** nvm installs Node under the user's home, not `/usr/bin`. If
  > you go the nvm route, the §6 unit files must use the absolute nvm path in `ExecStart`
  > (e.g. `/home/deploy/.nvm/versions/node/v22.x.x/bin/npm`) and set `Environment=PATH=` to
  > include that `bin`. A system-wide install (distro/NodeSource) keeps the `/usr/bin/npm`
  > units below valid — prefer it if available.

The app needs Node 20+; **Node 22 LTS is the sweet spot** — don't feel pinned to exactly 20.

### 2e. Install Postgres

```bash
sudo apt install -y postgresql postgresql-contrib
systemctl status postgresql      # should be active + enabled
```

26.04's default repo ships a current major (16/17-class). That's fine for a fresh DB — you do
**not** need to match dev's PG 14, and you do **not** need the PGDG apt repo. The default
cluster already listens only on `localhost:5432` (`listen_addresses = 'localhost'`), and
Ubuntu's default `pg_hba.conf` accepts password auth on `127.0.0.1/32` (`scram-sha-256`), so
the app connects over the loopback with a password and no `pg_hba` edits are required.

### 2f. Install nginx

```bash
sudo apt install -y nginx
systemctl status nginx           # active + enabled
```

Config comes in §7. (If you ran `ufw allow 'Nginx Full'` before this, it still applies once
nginx is up.)

### 2g. App directory

```bash
sudo mkdir -p /srv/multiblog
sudo chown deploy:deploy /srv/multiblog
```

### 2h. Swap (required on the 1 GB Nanode)

`next build` peaks well above 1 GB of RAM; on a 1 GB instance it will be OOM-killed partway
through with no useful error. Add 2 GB of swap once, up front:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
free -h                                                       # confirm Swap: 2.0Gi
```

Swap only has to cover the build; steady-state runtime stays comfortably under 1 GB. (If you
later resize to a ≥2 GB plan, the swap is harmless to leave in place.)

> **Swap alone isn't enough — confirmed on a real 1 GB Nanode.** `next build`'s TypeScript
> step still crashed with `JavaScript heap out of memory` even with the swap above active and
> almost entirely free. That error is V8 hitting **its own internal heap ceiling**, not an
> OS-level OOM-kill — V8 auto-sizes that ceiling from physical RAM alone and ignores swap, so
> on a ~956 MB box the default lands too low to get through the build regardless of how much
> swap is sitting idle. Fix: explicitly raise the ceiling so V8 actually reaches into the
> swap:
> ```bash
> NODE_OPTIONS="--max-old-space-size=3072" npm run build
> ```
> 3072 MB fits inside the ~3.4 GB combined RAM+swap with headroom left for Postgres/nginx/
> sshd. The build runs slower once it's actually swapping, but completes. This applies to
> every build on this box, not just the first — `deploy/deploy.sh` sets it already (§10).

---

## 3. Create the database + role

As the `postgres` system user, create a password-protected role and the DB (production uses a
password — unlike the dev box's passwordless `trust` setup, which you should **not** copy):

```bash
sudo -u postgres psql
```
```sql
CREATE ROLE multiblog WITH LOGIN PASSWORD '<strong-password>';
CREATE DATABASE multiblog OWNER multiblog;
\q
```

Connection string for the app:

```
DATABASE_URL="postgresql://multiblog:<strong-password>@127.0.0.1:5432/multiblog?schema=public"
```

> **Keep the password URL-safe.** It's embedded in `DATABASE_URL`, so a password containing
> `@ : / ? # %` will mis-parse the connection string (e.g. a `@` looks like the host
> delimiter). Use an alphanumeric password — `openssl rand -hex 24` is a good source — or
> URL-encode any reserved characters.

Quick sanity check: `psql "postgresql://multiblog:<pw>@127.0.0.1:5432/multiblog" -c '\conninfo'`.

---

## 4. Environment variables (prod `.env`, never committed)

`.env*` is gitignored — create it directly at `/srv/multiblog/.env` (systemd loads it via
`EnvironmentFile`). Full set:

```
DATABASE_URL="postgresql://multiblog:<pw>@127.0.0.1:5432/multiblog?schema=public"

AUTH_SECRET="<openssl rand -base64 32>"     # generate FRESH — do not reuse the dev secret
AUTH_TRUST_HOST=true                        # §1a
AUTH_URL="https://<app-host>"               # §1a

APP_URL="https://<app-host>"                # absolute links (reset links, RSS)
COLLAB_PORT=1234
NEXT_PUBLIC_COLLAB_URL="wss://<app-host>/collab"   # path-based; see note below
```

> **`NEXT_PUBLIC_COLLAB_URL` is baked into the client bundle at `npm run build`.** It's a
> `NEXT_PUBLIC_` var, inlined at build time (used in `PostEditor.tsx` and
> `LiveHistoryViewer.tsx`). It **must** be set to the final `wss://` URL *before* you build —
> changing it later requires a rebuild, not just a service restart. Same discipline for
> anything else `NEXT_PUBLIC_`.

No email provider is wired (`sendMail()` is a logging stub), so password-reset emails aren't
actually sent — the reset link just gets logged. `APP_URL` still matters for the RSS feed's
absolute links and that logged link text.

`AUTH_SECRET` also signs the short-lived collab JWTs (`src/lib/collab-token.ts`), so the app
and collab services **must share the same value** — both units point at this one `.env`.

---

## 5. First deploy — step by step

As `deploy`, in `/srv/multiblog`:

```bash
# 1. Get the code (the branch with the §1 changes)
git clone <repo> .            # or rsync the tree up

# 2. Install deps (need dev deps: prisma CLI, tsx, typescript are all build/runtime here)
npm ci

# 3. Create .env (§4) at /srv/multiblog/.env

# 4. Generate the Prisma client (gitignored — src/generated/prisma is not in the repo)
npx prisma generate

# 5. Apply migrations to the fresh DB  (deploy, NOT dev)
npx prisma migrate deploy

# 6. Seed the first admin (§1c)
npx tsx scripts/create-admin.ts labreuer@gmail.com "Luke Breuer" LB '<password>'

# 7. Build the Next app  (NEXT_PUBLIC_COLLAB_URL must already be set — see §4 note;
#    on the 1 GB Nanode, swap alone isn't enough — see the NODE_OPTIONS note in §2h)
NODE_OPTIONS="--max-old-space-size=3072" npm run build

# 8. Install & start the systemd units (§6), configure nginx (§7), then verify (§8)
```

Note on `npm ci` vs `npm ci --omit=dev`: **use the full install.** `prisma`, `tsx`, and
`typescript` live in devDependencies but are needed at deploy/runtime here — `prisma migrate
deploy`/`generate`, and `tsx` actually *runs* the collab server in prod (§1b). Pruning dev
deps would break the collab service and future migrations.

---

## 6. systemd units

Both are provided ready-to-copy in `deploy/multiblog-web.service` and
`deploy/multiblog-collab.service`.

`/etc/systemd/system/multiblog-web.service`:

```ini
[Unit]
Description=MultiBlog Next.js app
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/multiblog
EnvironmentFile=/srv/multiblog/.env
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/multiblog-collab.service`:

```ini
[Unit]
Description=MultiBlog Hocuspocus collab server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/multiblog
EnvironmentFile=/srv/multiblog/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm run collab:prod
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now multiblog-web multiblog-collab
```

(`next start` reads `PORT`; the collab server reads `COLLAB_PORT` from the env file. If you
used nvm in §2d, swap the `ExecStart` paths per that caveat.)

---

## 7. nginx

One server block on `<app-host>`: the app at `/`, collab under `/collab`. The full template
— HTTP→HTTPS redirect, TLS lines (filled by certbot, §7a), both `location`s — is in
`deploy/nginx-app.conf.sample`. The two proxy blocks:

**App** (`location /`):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # required for §1a trustHost
}
```

`X-Forwarded-Proto`/`Host` must be forwarded or NextAuth (with `trustHost`) can't build
correct https callback URLs. The `X-Real-IP`/`X-Forwarded-For` headers matter too:
`submitComment` records the commenter IP for rate-limiting, and `getClientIp()`
(`src/lib/request-ip.ts`) already reads `X-Forwarded-For` then `X-Real-IP` — so with the two
headers set above, the limiter sees the real client IP rather than `127.0.0.1`. Nothing to
change in the app; just don't drop those headers.

**Collab** (`location /collab`) — WebSocket upgrade + long read timeout:

```nginx
location /collab {
    proxy_pass http://127.0.0.1:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;      # keep idle editing sockets alive
    proxy_send_timeout 3600s;
}
```

No path rewrite is needed: `HocuspocusProvider` opens the socket at exactly
`NEXT_PUBLIC_COLLAB_URL` (`wss://<app-host>/collab`) and sends the document id (the post id)
in-band, not in the URL — so nginx just has to hand `/collab` to `:1234` untouched.

Reload after editing: `sudo nginx -t && sudo systemctl reload nginx`.

> **Alternative (not used here): a separate collab subdomain.** If you ever want collab on
> its own host (`collab.<domain>`) — e.g. to tune its timeouts in isolation — give it its own
> `server {}` with `location /` → `:1234`, add a DNS record and a cert covering that name (a
> 2-name SAN cert or a wildcard), and set `NEXT_PUBLIC_COLLAB_URL="wss://<collab-host>"`.
> Path-based is simpler and single-cert, so it's the default.

---

## 7a. TLS certificate (Let's Encrypt via certbot)

A free, auto-renewing single-domain cert — path-based means one hostname, so no wildcard and
no DNS-API plumbing (an HTTP-01 challenge over port 80 is enough).

> **Order matters — chicken-and-egg.** `deploy/nginx-app.conf.sample` listens on 443 and
> references `/etc/letsencrypt/live/<app-host>/…pem`, which **do not exist until certbot
> runs**. If you enable that config first, `nginx -t` fails on the missing cert and nginx
> won't start. So issue the cert *before* installing the 443 block. Prerequisites: DNS for
> `<app-host>` already resolves to this box, and port 80 is open (§2c).

1. **Bootstrap nginx with an HTTP-only block** so certbot has something to serve the
   challenge from. Put this in `/etc/nginx/sites-available/multiblog` (symlink into
   `sites-enabled/`), `sudo nginx -t && sudo systemctl reload nginx`:

   ```nginx
   server {
       listen 80;
       server_name <app-host>;
       root /var/www/html;   # anything; certbot only needs to answer /.well-known/…
   }
   ```

2. **Issue the cert:**

   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot certonly --nginx -d <app-host>
   ```

3. **Swap in the real config** — replace that file's contents with
   `deploy/nginx-app.conf.sample` (edited for `<app-host>`), then `sudo nginx -t &&
   sudo systemctl reload nginx`. The 443 block now finds the cert.

Step 2 writes `/etc/letsencrypt/live/<app-host>/fullchain.pem` and `privkey.pem` — exactly
the paths the sample's `ssl_certificate`/`ssl_certificate_key` lines point at. (Alternatively
`certbot --nginx` *without* `certonly` rewrites the server block for you in one shot — fine
too, but then certbot owns the TLS lines instead of the sample, and you'd skip step 3.)

Renewal is automatic: the certbot package installs a systemd timer. Ensure nginx reloads on
renew and verify the whole path:

```bash
echo 'sudo systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo certbot renew --dry-run
```

`ssl_certificate` must be the **fullchain** (leaf + intermediates), which is what the path
above gives you — a leaf-only file breaks chain-building for some clients. The private key
stays root-owned and out of the repo (the sample only carries the path, no key material).

---

## 8. Verify

- `systemctl status multiblog-web multiblog-collab` — both active. Logs:
  `journalctl -u multiblog-web -f`.
- `curl -I https://<app-host>/` → 200, home page renders.
- Sign in as the seeded admin — confirms auth + `trustHost` + DB.
- Open a post editor, type — confirms the collab WebSocket (`wss://`) connects (status line
  goes 🟢 Live). If it stays 🟡/🔴, check the collab unit logs and nginx upgrade headers.
- Publish a post, hit its public `/[slug]` — confirms the ISR rendering path.

---

## 9. Backups

Daily `pg_dump` off-box (cron), and **test a restore once** — an untested backup isn't one.

```bash
# /etc/cron.d/multiblog-backup  (adjust destination)
0 3 * * *  deploy  pg_dump "postgresql://multiblog:<pw>@127.0.0.1:5432/multiblog" | gzip > /var/backups/multiblog-$(date +\%F).sql.gz
```

Ship the dumps somewhere off the box (Linode Object Storage / another host). The `postCollab`
BYTEA and `postCollabUpdate` log are included in a normal `pg_dump`, so live editing state
survives a restore.

---

## 10. Redeploy flow (subsequent deploys)

```bash
cd /srv/multiblog
git pull
npm ci
npx prisma generate
npx prisma migrate deploy          # applies any new migrations, no-op if none
npm run build                      # re-inline NEXT_PUBLIC_* if any changed
sudo systemctl restart multiblog-web multiblog-collab
```

These steps are packaged as `deploy/deploy.sh` (run it from `/srv/multiblog` as `deploy`). No
zero-downtime story is needed at hobby scale — the restart blip is seconds. (Docker Compose
remains an easy later upgrade for
reproducibility, per PLAN.md §7.)
