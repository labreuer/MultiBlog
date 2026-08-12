# TODO

Open items with enough context to act on without re-deriving them. Anything that turns into
real design work should graduate to PLAN.md; anything that turns into a durable fact about
the box or the toolchain belongs in CLAUDE.md or DEPLOY.md instead.

---

## Server/client environment divergence has no check covering it

**Status:** two instances found and fixed on 2026-08-11; the *class* is still untested, and one
known instance is still open (below).

Both bugs that day were production-only **by construction** rather than by timing or load —
they depend on the server and the browser being different machines, which locally they never
are. `npm run e2e` and `web-prod` cannot catch either, and never will:

- **PLAN.md §13m** — the collab HTTP origin. Broken only when `NEXT_PUBLIC_COLLAB_URL` is set,
  which it deliberately never is in dev.
- **React #418 hydration mismatch** — `toLocaleString()` on a date inside a `"use client"`
  component, which reads the runtime's locale and timezone and so renders differently during
  SSR (UTC on the box) than during hydration (the reader's zone). Fixed by
  `src/components/LocalTime.tsx`; the rule and the two traps around it are in CLAUDE.md's
  Gotchas, since it's a standing convention rather than an open item.

**What's actually open:**

1. **`DocsTable.tsx:206` — `row.length.toLocaleString()` on a *number*.** Same class, still
   present. `DocsTable` is a client component fed by `app/docs/page.tsx`, so it is
   server-rendered, and number grouping is locale-dependent (`1,234` vs `1.234`). It diverges
   only for a viewer whose *locale* differs from the box's, not their timezone — so unlike the
   date case it does not fire for an en-US reader against an en-US-defaulted server, which is
   why it has not been seen. Not folded into the `LocalTime` fix because the trade-off differs:
   for a number there is no "correct" per-viewer answer worth a two-pass render, so pinning the
   locale (`toLocaleString("en-US")`) is probably right, and that is a decision rather than a
   mechanical substitution.

2. **No check covers the class.** A CI job running the suite with a UTC server and a non-UTC,
   non-en-US browser locale would catch every instance of both shapes at once — Playwright sets
   both per-context (`timezoneId`, `locale`), so this is a config change rather than new specs.
   Nothing today varies either, so every future instance lands in production the same way.

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

`/dashboard`'s contributor panel (added with §17) edits the avatar upload (§17n) plus
`contributorBlurb`/`contributorOrder`/`orcid`/`website` — but only for a user who is already
`isListedContributor`, and only those fields. `name`, `slug`, `color`, and `role` all remain admin-only
(`/users`), and a user who has never been listed as a contributor has no self-service surface
at all — not even to change their own display name. Whether that's worth a general profile
page, or whether it's fine as-is for a small trusted-author blog, is unresolved.

---

## Avatar route's `If-None-Match` handling is exact-match only (PLAN.md §17n)

`src/app/api/avatar/[userId]/[hash]/route.ts` decides whether to answer 304 with a single
string comparison:

```ts
const etag = `"${avatar.hash}"`;
if (request.headers.get("if-none-match") === etag) { /* 304 */ }
```

That covers the only form a browser actually sends — it echoes back verbatim whatever `ETag`
it was given — which is why the e2e assertion in `e2e/landing.spec.ts` passes and why this
has never misbehaved in practice. But three other forms are legal HTTP and all currently
fall through to a full 200 + body where a 304 was correct:

- **A weak validator**, `W/"<hash>"`. Weak comparison is what `If-None-Match` is *supposed*
  to use (RFC 9110 §13.1.2 — strong comparison is only for `If-Match`/ranges).
- **A list**, `"a", "b"` — a client that has seen more than one version of the resource.
- **`*`**, meaning "if any representation exists" — always a 304 for us, since reaching that
  line means the row was found.

**Why it's worth fixing rather than closing.** Nothing in front of the app sends these
*today*: DEPLOY.md's nginx is a plain reverse proxy with no `proxy_cache`, so browsers talk
to Next directly. It becomes real the moment a caching layer is added — nginx `proxy_cache`,
a CDN, or Cloudflare in front of the box — because intermediaries do normalize and rewrite
these headers. The failure is benign (wasted bandwidth, not wrong content), which is exactly
why it would go unnoticed.

**Two ways, roughly equal effort.**

1. Parse it inline: strip an optional `W/` prefix, split on commas, trim, compare each — plus
   an `*` short-circuit. ~8 lines, no new dependency.
2. The `fresh` package, which is what Express uses and handles the whole matrix in one call.
   One dependency, and half of what it does (`If-Modified-Since`, `Cache-Control: no-cache`)
   is dead weight here — this route serves one immutable representation with no
   `Last-Modified` at all.

Leaning (1) for that reason. Either way the e2e spec should grow the three cases alongside
the exact-match one it already asserts.

---

## Email/invites: deferred work (see docs/EMAIL.md for each item's design)

Design and reasoning live in [docs/EMAIL.md](docs/EMAIL.md) §7 — this is a pointer, not a
restatement, so it doesn't drift out of sync with that file.

- Email verification (double opt-in) — not built at all this pass.
- Bulk "send invites to selected users" on `/users`.
- Auto-sign-in immediately after accepting an invite (blocked on the same Auth.js v5
  server-action `signIn` limitation `src/app/sign-in/NOTES.md` documents).
- Richer HTML mail templates — `SendMailInput.html` exists but nothing sets it yet.
- A global hourly send budget (needs a counter table; today's per-address/per-user
  cooldowns bound damage per victim but not total volume).
- A scheduled sweep for an expired, never-re-invited invite's raw token — today it's only
  nulled when that user is invited again.

---

## `npm run e2e` fails ~1 run in 2 on a `useSession` 500 — the 2-worker mitigation has decayed

**Status:** known failure mode with an existing mitigation that no longer holds. Not an app
defect — every occurrence passes in isolation, and nothing here reaches production.

### This is already documented, in `playwright.config.ts` — not CLAUDE.md

Worth stating plainly because it is easy to go looking in the wrong file. `playwright.config.ts`
lines 17–24 name this exact symptom and record the measurement behind `workers: 2`:

> Two, not three. Three workers overload the *dev server*, not the machine: measured symptoms
> were a public page 500ing with next-auth's "useSession must be wrapped in a
> `<SessionProvider />`" during SSR, and server actions arriving with truncated bodies
> ("Unexpected end of JSON input" on `/posts/[id]/edit`), neither reproducible in isolation and
> neither an app defect. Failure rate was roughly 1 full run in 3.5 at three workers, 0 in 8 at
> two — for the same ~50s wall clock, because the dev server is the bottleneck rather than the
> parallelism.

CLAUDE.md's *Checks & verification* section documents a **different** dev-server failure — a
killed `next dev` poisoning `.next/dev` so the next start hangs compiling
`/api/auth/[...nextauth]`, killing every spec in `auth.setup.ts`. Same neighbourhood, different
fault: that one hangs and takes down the whole run, this one 500s a single page render.

### The mechanism, verified against the installed package

`node_modules/next-auth/react.js` (v5 beta):

```js
export const SessionContext = React.createContext?.(undefined);

export function useSession(options) {
    if (!SessionContext) {
        throw new Error("React Context is unavailable in Server Components");   // :72
    }
    const value = React.useContext(SessionContext);
    if (!value && process.env.NODE_ENV !== "production") {
        throw new Error("[next-auth]: `useSession` must be wrapped in a <SessionProvider />"); // :77
    }
```

Two things follow. The `:77` throw is **dev-only** by its own guard, which is why this has never
been seen under `web-prod`. And the app's wiring is not at fault: `SessionProvider` wraps
`{children}` in the root layout (`src/app/layout.tsx:34`), and `CommentForm`
(`src/components/CommentForm.tsx:1,29`) is a plain `"use client"` component calling `useSession()`
unconditionally. Under load the *consumer* transiently resolves a context the *provider* never
wrote to — a compile/module-graph race inside `next dev`, not a missing provider.

### What it looks like when it fires

Always the same shape: a public post page (`/[slug]`) 500s server-side, and `gotoOk`
(`e2e/fixtures.ts:209`) turns that into a readable failure by embedding the response body:

```
Error: GET /<slug> returned 500, expected 200. Response body:
  …
    at useSession (.next/dev/server/chunks/ssr/node_modules_….js:420:15)
    at CommentForm (.next/dev/server/chunks/ssr/[root-of-the-server]_….js:612:183)
    at gotoOk (e2e/fixtures.ts:214:11)
    at e2e/publish.spec.ts:73:5
```

`gotoOk` is doing its job here — a bare status assertion would report only `500`. Keep it.

### Why it is back: the mitigation was calibrated against a much smaller suite

The "0 in 8 at two workers" measurement was taken at commit `968e077` (2026-07-25), when `e2e/`
held **5 spec files**. It now holds **13** (89 tests across 15 files, counting `auth.setup.ts`
and `cleanup.teardown.ts`), and a full run takes ~2.2–2.9 min rather than the ~50s that comment
cites. Same two workers, roughly triple the sustained
compile-and-render load on one `next dev` — so the headroom the worker count was chosen to buy
has been spent by the suite growing into it.

Observed 2026-08-06 across roughly six full-suite runs at `workers: 2`: two fully green, and at
least three ending with `publish.spec.ts:48` ("edits made after publishing only reach the public
page on republish") failing this way, each passing immediately when re-run alone.

**Not to be confused with the `admin-table.spec.ts:476` failures from the same day**, which
looked like the same thing and were not. Capturing that one's `error-context.md` showed an
ordinary assertion diff — an `E2E doc …` row from another worker's fixture appearing between two
of the three `/docs` page loads that test compared for exact equality — i.e. a cross-worker race
on ambient rows, in the test itself, with no 500 and no `useSession` anywhere. Fixed by pinning
that assertion to two docs the test creates and filters to with `?q=`. Worth recording as the
cautionary case: two unrelated faults in one suite, both intermittent, both cleared by an
isolated re-run, and the only thing that told them apart was reading the captured body.

### Options, roughly in order of cost

1. **`workers: 1` locally.** Certain to fix it; costs wall-clock on a suite that is already the
   slowest check. Measure first — the config's own point is that the dev server, not the
   parallelism, is the bottleneck, so 1 worker may cost far less than 2× and might even be near
   parity now.
2. **Run the suite against `next start`, not `next dev`.** Removes the whole class: the `:77`
   throw is compiled out under `NODE_ENV=production`, and there is no on-demand compilation to
   race. `.claude/launch.json` already defines `web-prod` (`next start` on :3001) for exactly the
   "dev doesn't behave like prod" family of problems. Costs a `npm run build` before each run and
   loses the fast edit-rerun loop, so it likely wants to be a second mode (`npm run e2e:prod`)
   rather than a replacement — and it is the shape CI would want anyway.
3. **Targeted retry.** `retries: 1` would paper over it, and `playwright.config.ts:27` explicitly
   refuses that: *"a retry that turns a red run green hides exactly the collab/WS timing
   regressions this suite exists to catch."* Do not do this without revisiting that decision on
   its own terms.
4. **Upstream.** Whether next-auth v5 beta still resolves `SessionContext` this way is worth a
   look before building anything — `next-auth@^5.0.0-beta.32` is pinned to a beta, and this is
   the kind of thing a later beta fixes outright.

### Which throw it is — resolved 2026-08-06

The `:77` one, **`[next-auth]: useSession must be wrapped in a <SessionProvider />`** — the
same one `playwright.config.ts` recorded for the 3-worker era. Captured from a
`publish.spec.ts:48` failure's `error-context.md`, whose bundled frame
(`node_modules_….js:420:15`) lands between these two lines of the emitted chunk:

```js
418 | const value = …["useContext"](SessionContext);
419 | if (!value && ("TURBOPACK compile-time value", "development") !== "production") {
```

So `SessionContext` is truthy and `useContext` returned undefined: a **context-value race**,
not `:72`'s *"React Context is unavailable in Server Components"*, which would have meant a
server/client module-graph split and a different fix. Both strings appear in the artifact
because the error page prints the surrounding source — read the line number, not a grep.

Line 419 also shows Turbopack inlining `NODE_ENV`, which is the direct evidence that this
throw is compiled out of a production build. That is why `web-prod` cannot hit it, and why
option 2 above removes the class rather than merely reducing its odds.

**Capturing it again:** `gotoOk` embeds the response body, which lands in
`test-results/<test-slug>/error-context.md` and in the HTML report (`npm run e2e:report`).
**A later isolated re-run deletes that directory** — read it, or copy it out, before
re-running anything.
