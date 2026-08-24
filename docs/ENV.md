# Environment variables

`.env` is never committed. This is the full catalogue; CLAUDE.md carries only the pointer
and the two or three values you cannot work without. The three that make a working tree a
*slot* rather than a copy — `DEV_HOST`, `WEB_PORT`, `COLLAB_PORT` — are explained in
[DEV_SLOTS.md](DEV_SLOTS.md); this file records what each variable *is*.

## The rule that decides how a change takes effect

A **bare** variable is read by the Node process at runtime, so changing it needs a
**restart**. A **`NEXT_PUBLIC_`** variable is substituted into the client bundle by textual
match at build time, so changing it needs a **rebuild**. Several variables below are
deliberately bare for exactly that reason — a deployment changes its upload limit or its
banner without rebuilding — and it is why two variables sometimes hold the same number.

Textual substitution also means a `NEXT_PUBLIC_` var has to be read as a full literal
member expression (`process.env.NEXT_PUBLIC_COLLAB_PORT`), never destructured, aliased or
computed. `src/lib/collab-url.ts` depends on this.

## Required

| variable | notes |
|---|---|
| `DATABASE_URL` | This slot's database. Never point a second checkout at the first's — see [DATABASE.md](DATABASE.md). |
| `AUTH_SECRET` | `openssl rand -base64 32`. |
| `APP_URL` | Used for absolute links. **Nothing binds a port from `APP_URL`** — slot B carried one naming its own port and went on binding :3000 every time. |
| `COLLAB_PORT` | The Hocuspocus port. Bare, so not readable client-side at all — hence `NEXT_PUBLIC_COLLAB_PORT` below. |

## Slot-defining

| variable | default | notes |
|---|---|---|
| `DEV_HOST` | `localhost` | The hostname this slot is reached on. Not redundant with the port: cookies key on host and ignore port. |
| `WEB_PORT` | 3000 | The dev server's port. `WEB_PORT + 1` (preview tool's `web-prod`) and `WEB_PORT + 2` (e2e prod target) are derived, never configured. |

Both default sensibly when absent, so an unedited `.env` behaves exactly as it did before
slots existed. Read through `scripts/dev-ports.ts` and its hand-kept PowerShell mirror
`scripts/dev-ports.ps1`. Full rationale: [DEV_SLOTS.md](DEV_SLOTS.md).

## Collab: three variables answering three different questions

This is the one cluster where picking the wrong variable produces a bug that is invisible
locally and total in production.

### `NEXT_PUBLIC_COLLAB_PORT` (default `1234`) — "which port does the *browser* connect to?"

Holds the same number as `COLLAB_PORT`, but readable client-side. This pair is what lets a
second slot move its collab port *without* pinning `NEXT_PUBLIC_COLLAB_URL`. Slot B pinned
the URL until this variable existed, which silently defeated the per-request derivation
below.

### `NEXT_PUBLIC_COLLAB_URL` — "what is the browser's websocket URL?"

**Leave unset for local dev.** `getCollabUrl()` (`src/lib/collab-url.ts`, the one function
every client-side `HocuspocusProvider` call goes through) derives
`ws://<the page's own host>:<NEXT_PUBLIC_COLLAB_PORT>` per request instead, so the same
running dev server works from `localhost` *and* from a LAN IP (testing from a phone) with
no restart.

Set it explicitly only for a real deployment — a different host or subdomain, or `wss://`.
Once set it pins every client to that one value, host included, which is what defeats the
derivation.

### `COLLAB_INTERNAL_URL` (optional, bare) — "how does the *Next server* reach collab?"

The Next server calls the collab process directly over plain HTTP:
`/admin/ydoc-snapshot`, `/admin/annotation-mark`, `/admin/annotation-unmark`,
`/admin/annotation-flush`. That origin comes from `src/lib/collab-http-origin.ts` —
`COLLAB_INTERNAL_URL` falling back to `http://127.0.0.1:${COLLAB_PORT}` — and must
**never** be derived from `NEXT_PUBLIC_COLLAB_URL`.

It was, once, and the bug was invisible locally and total in production: the public URL is
`wss://<host>/collab`, nginx forwards `/collab/...` unrewritten, the handler matches on
`/admin/...`, and Hocuspocus answers an unmatched path with a **`200 "Welcome to
Hocuspocus!"`** — so all four endpoints silently no-opped while the websocket worked fine.
The symptom was "Annotation can't be empty." on every annotation. PLAN.md §13m has the full
account. The generalizable half: a `NEXT_PUBLIC_` var answers "how does the *browser* reach
this", which is the wrong question for a server-to-server call and happens to give the same
answer as the right one only until a reverse proxy exists.

### Not an env var, but the same class of confusion

`next.config.ts`'s `allowedDevOrigins` is the separate, unrelated setting for letting a
non-localhost origin reach the Next dev server itself (HMR, RSC) at all. Needed for the
same phone-on-LAN case, but for the web server rather than the collab one — and it does
need a **restart**, since it is read at `next dev` startup.

## Testing

| variable | notes |
|---|---|
| `E2E_WORKERS` | An **override, not the setting**. The default is derived in `playwright.config.ts` from `os.cpus().length`, clamped so it never exceeds a count an actual measurement produced. |

Set it only to contradict that derivation, and the symptom that warrants it is specific:
red tests scattering across unrelated specs, not repeating between runs, all passing at
`E2E_WORKERS=1`. `playwright.config.ts` already imports `dotenv/config` (it needs
`DATABASE_URL` for the DB helpers), so a value here is in `process.env` before
`defineConfig` evaluates.

## File storage

| variable | default | notes |
|---|---|---|
| `FILE_STORAGE_DIR` | `.file-storage/` | Content-addressed PDF bytes. A second backup surface `pg_dump` does not cover — see DEPLOY.md. |
| `FILE_MAX_UPLOAD_BYTES` | 50 MB | |

Both bare, so a deployment changes its upload limit with a **restart, not a rebuild**. That
is precisely why the browser learns the limit from `/api/files/limits` rather than from a
baked-in constant: the client-side pre-check and the server's enforcement are then provably
the same number. nginx's `client_max_body_size` has to be raised to match
(`deploy/nginx-app.conf.sample`).

## Site presentation

| variable | default | notes |
|---|---|---|
| `NEXT_PUBLIC_SITE_TITLE` | `"MultiBlog"` | `src/lib/site-config.ts`. Env-sourced rather than hardcoded so a real deployment's title survives `git pull` instead of living in a tracked file. |
| `SITE_BANNER` | — | Landing-page banner image path. `src/lib/site-banner.ts`, PLAN.md §17b. |
| `SITE_BANNER_ASPECT` | — | Its aspect ratio. |
| `SITE_BANNER_ALT` | — | Its alt text. |

The three `SITE_BANNER*` vars are bare, unlike `NEXT_PUBLIC_SITE_TITLE`, on purpose: they
are read server-side only, so changing them needs a **restart, not a rebuild** — and the
image file itself (`public/banner.*`, gitignored) needs neither, since `public/` is served
straight from disk at runtime.

## Mail

| variable | notes |
|---|---|
| `RESEND_API_KEY` | Unset keeps every environment on the logging stub. |
| `MAIL_FROM` | |
| `RESEND_INVITE_TEMPLATE_ID` | A Resend Template id for the invite email specifically (`sendUserInvite`, `src/app/actions/users.ts`). Unset falls back to a plain text/subject send rather than failing, so invites work with no template ever created in the dashboard. |

All bare — a restart, not a rebuild. Any recipient on `@example.com` or `@sample.invalid`
is never delivered to in any environment regardless of whether a key is set, so `npm run
e2e` stays safe with a live key in `.env`. Design and what is deferred: [EMAIL.md](EMAIL.md).
