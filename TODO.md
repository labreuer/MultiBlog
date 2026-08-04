# TODO

Open items with enough context to act on without re-deriving them. Anything that turns into
real design work should graduate to PLAN.md; anything that turns into a durable fact about
the box or the toolchain belongs in CLAUDE.md or DEPLOY.md instead.

---

## Observability of swallowed bulk-action failures

**Status:** partly resolved. The failures *are* logged and *are* retrievable in production.
What is missing is retention, structure, and any path off the box.

### Background — why there is anything to log

The batched admin-table actions return a `BulkResult` rather than throwing, so each row can
paint its own border (PLAN.md §16f). `settleBulk` (`src/lib/bulk-result.ts`) uses
`Promise.allSettled`, which **captures** the rejection — so nothing propagates to Next, and
Next's own error handling never sees it. Two consequences follow, and they pull in opposite
directions:

- The admin sees a filtered message. A plain `Error` (this codebase's own authorization
  guards) is shown verbatim; anything else — a Prisma rejection carrying the failing query
  and absolute source paths — collapses to `"Something went wrong on the server."`
- Because nothing throws, **Next logs nothing**. Under the previous `Promise.all` the first
  rejection propagated out of the server action and Next logged it server-side (with a digest
  in production, precisely so a generic client message could be correlated back).

`settleBulk`'s `console.error` exists to replace what `allSettled` took away. It is
load-bearing, not incidental — deleting it as "stray logging" silently reopens the hole.
Verified present in the production bundle (`removeConsole` is not configured):

```
.next/server/chunks/ssr/[root-of-the-server]__07s4rr-._.js
  console.error(`[bulk] ${a[c]} failed:`
```

### Where it lands in production

`multiblog-web.service` is `Type=simple` with `ExecStart=/usr/bin/npm run start` and sets no
`StandardOutput`/`StandardError`, so systemd's defaults apply and both streams go to the
**journal**:

```bash
journalctl -u multiblog-web -f              # the app, incl. [bulk] lines
journalctl -u multiblog-collab -f           # the collab server (doc-cache.ts logs here)
journalctl -u multiblog-web --since '1 hour ago' | grep '\[bulk\]'
```

DEPLOY.md §8 already points at `journalctl -u multiblog-web` for diagnosing a 500, so this is
the same stream, not a new one. Next's own redaction logging for *thrown* server-action
errors goes to the identical place — the digest mechanism implies a separate error sink and
there isn't one.

**Correlation key is the row id**, which appears in the log line and identifies the row the
UI reddened:

```
[bulk] cmsdhlfje0001ggj1vilqnn1a failed: Error [PrismaClientKnownRequestError]:
  Foreign key constraint violated on the constraint: `user_deleted_by_user_id_fkey`
    at async deleteUser (src\app\actions\users.ts:128:3)
    at async settleBulk (src\lib\bulk-result.ts:64:19)
  code: 'P2003'
```

Only the redacted failures are logged. A guard the admin reads in full is ordinary feedback,
not a fault, and logging every refused authorization at error level would bury the real ones.

### What is actually open

1. **Journal retention is unverified.** `journald`'s `Storage=auto` is persistent only if
   `/var/log/journal` exists, and volatile (`/run/log/journal`, lost on reboot) otherwise.
   Ubuntu usually ships the persistent directory, but nothing in DEPLOY.md confirms it for
   this box. Check `journalctl --disk-usage` and `systemd-analyze cat-config systemd/journald.conf`;
   if it is volatile, a reboot discards every `[bulk]` line and the 500 diagnostics §8 relies
   on. One-line fix (`sudo mkdir -p /var/log/journal && sudo systemd-tmpfiles --create --prefix /var/log/journal`).

2. **Nothing ships off the box.** DEPLOY.md §9 backs up Postgres only. Logs die with the
   instance — the same instance whose failure is the case you would most want them for.

3. **`instrumentation.ts` would not capture these — the trap worth writing down.** Adding
   Sentry/OTel via Next's `onRequestError` hook looks like it would cover this and would not:
   that hook fires for errors Next *handles* (uncaught in rendering, route handlers, server
   actions). `settleBulk` catches them and returns a value, so they never reach Next as
   thrown errors. Wiring a provider requires an explicit report call at the same point the
   `console.error` sits, or the bulk failures are precisely the ones missing from the
   dashboard.

4. **The log line is unstructured.** `console.error` with an interpolated id is greppable but
   not queryable. Worth revisiting only alongside (2) — structure is cheap to add when
   something is consuming it and pointless before.

### Suggested smallest step

`instrumentation.ts` with `onRequestError` wired to a no-op reporter, plus a call to that same
reporter inside `settleBulk`. That puts both classes of error — the ones Next handles and the
ones this code deliberately swallows — through one seam that can later point at a provider,
without committing to one now. Item 1 is independent and worth checking on the box regardless.

---

## Admin table kit: Phase 5 not built

PLAN.md §16h (staging changes in IndexedDB, before they hit the server) was never
implemented. §16j's build order lists it as the one phase skipped; §16i (column visibility/
order) and §16m (site-wide defaults) both shipped without it.

---

## No public archive of older posts (PLAN.md §17d/§17m)

The landing page now shows only the 10 most recent published posts (`take: 10`, added
alongside the rest of §17). Before that it was unbounded, so this is a real behavior change:
the 11th-newest post and everything older is reachable only via search, RSS, or a direct
link — nothing on the site links to "older posts" from here. `/posts` is the admin table and
isn't a public substitute. Worth a `/archive` (or paginated `/`) if this ever needs to be
browsable rather than just searchable.

---

## No self-service profile page beyond the contributor panel (PLAN.md §17g/§17m)

`/dashboard`'s contributor panel (added with §17) edits `image`/`contributorBlurb`/
`contributorOrder`/`orcid`/`website` — but only for a user who is already `isListedContributor`,
and only those five fields. `name`, `slug`, `color`, and `role` all remain admin-only
(`/users`), and a user who has never been listed as a contributor has no self-service surface
at all — not even to change their own display name. Whether that's worth a general profile
page, or whether it's fine as-is for a small trusted-author blog, is unresolved.
