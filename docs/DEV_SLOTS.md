# Development slots

This machine runs two working trees side by side, so a branch can be worked on without
disturbing what the other tree is serving. A *slot* is a working tree plus its own `.env`,
its own Postgres database and its own `.file-storage`.

| | slot A | slot B |
|---|---|---|
| working tree | `~/Claude/Projects/MultiBlog` (main worktree) | `~/git/MultiBlog` (git worktree) |
| `DEV_HOST` | `localhost` | `b.localhost` |
| `WEB_PORT` (dev server) | 3000 | 3005 |
| `WEB_PORT + 1` (preview tool's `web-prod`) | 3001 | 3006 |
| `WEB_PORT + 2` (e2e prod target) | 3002 | 3007 |
| `COLLAB_PORT` | 1234 | 1235 |
| database | `multiblog` | `multiblog_b` |

Three values in `.env` define a slot — `DEV_HOST`, `WEB_PORT`, `COLLAB_PORT` — read through
`scripts/dev-ports.ts` and its hand-kept PowerShell mirror `scripts/dev-ports.ps1`. Every
port literal that used to be spread across `package.json`, `playwright.config.ts`,
`check-ports.ps1`, `stop-all.ps1` and `e2e-web.ps1` now comes from that one module.

## Why only two web ports are configured

`WEB_PORT + 1` is the preview tool's `web-prod` and `WEB_PORT + 2` is the e2e prod target,
so a slot owns three consecutive web ports and slots sit five apart — 3003/3004 are slack,
and a third slot belongs at 3010.

**Collab takes one port per slot and no block**, which is a fact about the app rather than a
simplification: there is exactly one `new Server(...)` in the codebase (`server/collab.ts`),
every `documentName` is `ydoc:`-prefixed and multiplexed over that one process (annotations
included, via `ydoc:annotation:<id>`), and the e2e prod target reuses the running collab
server rather than starting a second.

## `DEV_HOST` is not redundant with the ports

This is the part worth remembering. **Cookies key on host and ignore port entirely** — they
predate the origin model — so two slots on one hostname share a single
`authjs.session-token` however far apart their ports are: signing into one silently
invalidates the other, and because the stale cookie is *present* rather than absent it fails
as a JWT decrypt error, which reads like an auth regression.

Every other browser store (IndexedDB, `localStorage`) is origin-scoped and so already
separated by port alone. Cookies are the sole exception, and the sole reason a second
hostname exists.

`*.localhost` is used rather than a hosts-file entry because it:

- resolves to 127.0.0.1 through Node's own resolver with no entry and no elevation,
- is already in Next's built-in dev-origin allowlist, so it needs no `allowedDevOrigins` line,
- and is trusted by NextAuth under `next dev`.

An invented TLD like `multiblog-b.test` fails the first two of those.

## The port cannot come from `.env`

`npm run dev` is `scripts/dev-web.ts`, not a bare `next dev`. Next resolves `--port` through
commander's `.default(3000).env('PORT')` while argv is parsed, and loads its own `.env` files
later, so **a `WEB_PORT` or `PORT` line in `.env` cannot reach it** — the port has to be on
the command line.

This is not hypothetical: slot B carried an `APP_URL` naming its own port for a while and
went on binding :3000 every time, because nothing binds from `APP_URL`.

## The git guard

Because the two trees share one repository, `git worktree list` from either shows both, and
**the same branch cannot be checked out in both at once** — which is the guard that makes the
arrangement safe rather than a second clone's honour system. Uncommitted work does *not*
cross between them.

## The one place a port is still literal

`.claude/launch.json` defines `web`, `collab`, and `web-prod` for the preview tool. The
preview tool reads static JSON and cannot compute `WEB_PORT + 1`, so its numbers are slot
A's. In slot B the `web`/`web-prod` entries point at ports nothing is listening on — drive
that slot from `npm run dev:all` and open the pane on `http://b.localhost:3005` directly.

`web-prod` runs `next start` on :3001 (so it can coexist with a `dev:all` on :3000) against
whatever `npm run build` last produced. Use it for anything caching-related, since `next dev`
doesn't enforce the static/dynamic split or the Full Route Cache. It shells through `pwsh` to
set `AUTH_TRUST_HOST`/`AUTH_URL`, without which NextAuth rejects `localhost:3001` as an
`UntrustedHost` under `next start` — see CACHING.md's 2026-07-24 entry.

## Adding a third slot

Slots are hand-configured; there is no setup script (TODO.md tracks that gap). The steps:

1. `git worktree add <path> <branch>` from either existing tree.
2. Write that tree's `.env` with `DEV_HOST=c.localhost`, `WEB_PORT=3010`, `COLLAB_PORT=1236`,
   and a `DATABASE_URL` naming its own database. The `multiblog` role has CREATEDB, so no
   superuser is needed:
   `psql -U multiblog -h 127.0.0.1 -d postgres -c "CREATE DATABASE multiblog_c OWNER multiblog"`.
3. `npx prisma migrate deploy` and `npx tsx scripts/seed-sample-data.ts` from that tree.

The separate database is not optional — see [DATABASE.md](DATABASE.md) for the drift-reset
failure it exists to prevent.
