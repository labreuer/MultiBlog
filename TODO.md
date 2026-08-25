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

**Measured 2026-08-25, on a real iPhone (iOS 18.6.2) via `scripts/remote-console.ts`.** The
device was set to `Asia/Tokyo` against a `America/Los_Angeles` server — a divergence of a full
calendar day — and 13 pages were loaded with `console.error` captured from before hydration:
`/docs` `/files` `/posts` `/annotations` `/users` `/` `/search` `/ydoc-debug`, a post, a doc,
both editor routes, and a post with comments. **Zero hydration errors.** The teeth are
verifiable rather than assumed: the post page's `<time>` elements read `8/26/2026, 2:46 AM`
where the server would have emitted `8/25/2026, 10:46 AM`.

So the **date** half of this class is now empirically clean, and the reason generalises: every
`toLocale*` on a date in a client component (`PostSnapshotScrubBar`, `DocScrubBar`,
`YdocDebug`) renders only behind a client-side fetch, so the text is never in the SSR HTML;
every other call site is a Server Component. That is a property of today's code, not a
guarantee — item 2 is still what would keep it true.

**Item 1 is still unverified, and there is a trap for whoever tries.** Setting the phone's
**Region** to Germany does *not* move `navigator.language`, which stayed `en-US`; iOS keys
`Intl` off the **Language** setting instead. With Region alone changed, `DocsTable` rendered
`1,380` on both sides and nothing diverged. Reproducing item 1 on a device therefore means
changing the phone's language outright — which is why the Playwright `locale` option in item 2
is the cheaper path to it.

---

## Mobile layout: nav tap targets, and the PDF annotations panel covering the document

**Status:** both measured 2026-08-25 on an iPhone 13 Pro (390×663 viewport) and reproduced on
an iPad, via `scripts/remote-console.ts`. Neither is a regression; both are simply invisible to
a suite that only ever renders at desktop widths.

1. **Header nav tap targets are ~19–20px tall.** `MultiBlog`, `Posts`, `Docs`, `Users`,
   `Files`, `Site Settings` all measure 19–20px high against Apple's 44pt guidance, on every
   page swept. Nothing is broken — they are tappable — but they are roughly half the
   recommended target and sit adjacent to one another in a horizontally scrolling row.

2. **`/pdf/[slug]` opens the annotations panel over the document at narrow widths.** The
   `aside` carries `panelOpen` on first load, so a phone visitor lands on a PDF page and sees
   "Annotations" with no PDF until they find "Hide annotations". Reproduced across reloads and
   on both devices; the iPad hits it too, because landscape is **1194px** — six pixels under
   the 1200px threshold where the margin-notes rail engages (PLAN.md §18).

Worth noting what is *not* wrong: no page overflows horizontally. `documentElement.scrollWidth`
equals the 390px viewport everywhere, and the elements reaching 857px are inside a parent with
`overflow-x: auto`, which is the intended scroll container.

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

## Upstream follow-ups from the e2e flakiness work

**Status:** the local half is done. This item used to be "`npm run e2e` fails ~1 run in 2 on a
`useSession` 500 — the 2-worker mitigation has decayed"; the 2026-08-23 investigation
([docs/playwright-flakiness.html](docs/playwright-flakiness.html)) ran the suite 30 times with
both servers' output captured, split the flakiness into five mechanism classes, and landed
fixes for all of them — including this item's own Option 2: `npm run e2e` now targets a
production build on :3005, which compiles the dev-only `useSession` throw out entirely, and
the dev lane's `devServer500Watch` fixture names this class in a red test's annotations when
it does fire there. Two upstream actions remain; neither blocks anything.

### 1. File the `useSession` context-value race against next.js/next-auth

The 2026-08-22 research sweep found **no existing issue** for this intermittent form — the
known "must be wrapped" reports are all deterministic setup mistakes — so a report would be
novel, and the evidence below is the report's content. It matters because the chunk files it
came from (`.next/dev/server/chunks/ssr/…`) no longer exist:

- `node_modules/next-auth/react.js` (v5 beta) has two distinct throws in `useSession`: `:72`
  "React Context is unavailable in Server Components" (`!SessionContext`) and `:77`
  "[next-auth]: `useSession` must be wrapped in a <SessionProvider />" (`!value`, gated on
  `process.env.NODE_ENV !== "production"`).
- A captured failure's bundled frame (`node_modules_….js:420:15`, between
  `const value = …["useContext"](SessionContext);` and
  `if (!value && ("TURBOPACK compile-time value", "development") !== "production")`) pins it
  as the `:77` **context-value race**: `SessionContext` truthy, `useContext` returning
  undefined during SSR of `/[slug]`, thrown from `CommentForm` — while `SessionProvider`
  demonstrably wraps `{children}` in the root layout. A consumer transiently resolving a
  context the provider never wrote to is a `next dev` compile/module-graph race, plausibly
  the same rebuild-window family as vercel/next.js#97594 (manifests re-read per request while
  the bundler rewrites them). The inlined `NODE_ENV` on that line is also the direct evidence
  the throw is compiled out of production builds.
- Trigger profile for the repro section: parallel Playwright workers against one `next dev`
  with compiles in flight; never reproduces in isolation, under `next start`, or in 30
  steady-state (no-rebuild) suite runs; the pre-fix rate was ~1 red run in 3.5 at three
  workers on a 6-core machine.

**Capturing a fresh specimen** (the report is stronger with a current one): run the dev lane
under load while editing source, and read the 500 body from
`test-results/<test-slug>/error-context.md` — `gotoOk` embeds it, `devServer500Watch`
annotates it, and **a later isolated re-run deletes that directory**, so copy it out first.

### 2. Before any Next bump: recheck the manifest-race fix PRs

The other dev-only 500 class — `next dev`'s non-atomic read-modify-write of
`prerender-manifest.json`, re-triggered every ~60s by `revalidate = 60`
([vercel/next.js#96664](https://github.com/vercel/next.js/issues/96664), plus #96259 and
#97594) — had fix PRs **#96384 / #96695 / #97593 open and unmerged as of 2026-08-23**, so no
released Next (including canary) contains a fix. Two consequences:

- A Next upgrade taken in hope of fixing dev flakiness would be wasted motion until one of
  those merges — check the PRs first, and drop `scripts/check-ports.ps1`'s manifest
  `JSON.parse` tripwire only once a fixed version is actually installed.
- The error string it emits, `Unexpected end of JSON input`, is the same one the old
  `playwright.config.ts` comment misattributed to "server actions arriving with truncated
  bodies" — the real body-truncation bug (#85810) is fixed in 16.2.11 and required a Node
  middleware this repo doesn't have. If that string reappears post-upgrade, it's the
  manifest, not the actions.

---

## (optional) A pending selection is anchored by offsets plus a text search

**Status:** open, and deliberately optional — nothing is broken, the anchor is just weaker than
the one the collaborative carets already enjoy. A cheap mitigation was tried on 2026-08-12 and
reverted as too brittle.

**Moved to [docs/COLLAB.md](docs/COLLAB.md)**, which is now where every anchoring strategy and
trade-off lives rather than being spread across here and PLAN.md. Read
[§4](docs/COLLAB.md#4-the-in-progress-selection--offsets-plus-a-re-resolve) for the present
failure envelope and the reverted fix, then [§5](docs/COLLAB.md#5-yjs-relative-positions) for
the structural fix and its one real prerequisite: `DocScrubBar` pushes historical bodies through
the same `setContent` path that discards the mapping, so decoupling the scrub preview onto its
own editor comes first.

[§6](docs/COLLAB.md#6-anchors-carried-in-the-awareness-channel) is the alternative worth
weighing against it — it fits this case better than durable anchoring does, and would make an
in-progress selection visible to other people on the page, which no option here does today.

---

## No setup script for a new worktree (slots are hand-configured)

**Status:** open, 2026-08-24. Two slots exist and both work; nothing automates a *third*, and
nothing at all covers a worktree created by `claude -w`.

Supersedes "The e2e port configuration ignores this checkout's own `.env`", which this day's
work closed: `npm run dev` is `scripts/dev-web.ts` and passes `-p` explicitly, `BASE_URL` and
`check-ports.ps1`'s `$ports` both derive from `scripts/dev-ports.ts`, and the two slots hold
separate databases and separate `.file-storage` directories — so Playwright adopting the other
checkout's server, and the PDF-download 503s that followed from a shared `file` table, are both
structurally impossible now rather than merely detected. The arrangement itself is a durable
fact about the box and so lives in docs/DEV_SLOTS.md, not here.

**What is still manual.** A slot is three values in `.env` plus a database, and I typed both
slots' worth. `.env` is gitignored, so a newly created worktree starts with *no* `.env` at all:
it cannot reach a database, and copying slot A's in gives it slot A's ports, which is the
collision the whole arrangement exists to prevent. `scripts/dev-ports.ts` made the values flow
from one place; it did not make them *allocate*.

**Why this becomes urgent rather than tidy.** `claude -w` / `--worktree` creates worktrees under
`.claude/worktrees/` — that directory already exists in this repo, empty — and the desktop app
gives every session its own worktree automatically. Those are precisely the trees the slot model
does not know about. The first time either is used against this repo, the new tree either fails
to start or quietly fights slot A for :3000.

**What a new worktree needs beyond what git gives it:**

1. **A derived `.env`, not a copied one** — `DEV_HOST=<n>.localhost`, `WEB_PORT=3000 + 5n`,
   `COLLAB_PORT=1234 + n`, `DATABASE_URL` naming `multiblog_<n>`, and its own `AUTH_SECRET`.
   `NEXT_PUBLIC_COLLAB_URL` and `FILE_STORAGE_DIR` must be left **unset**: each one defeats a
   slot when pinned, for reasons recorded in slot B's `.env` comments (the first pins the host
   as well as the port, the second is what made two checkouts share one storage directory).
2. **`npm ci` and `npx prisma generate`** — `node_modules` and `src/generated/prisma` are
   gitignored and do not carry over. This is the bulk of the wall-clock cost, and the reason
   slots here are worth keeping warm rather than creating per task.
3. **Its own database** — `CREATE DATABASE multiblog_<n> OWNER multiblog` (the `multiblog` role
   has CREATEDB, so no superuser and no elevated shell), then `npx prisma migrate deploy`, then
   optionally `npx tsx scripts/seed-sample-data.ts`. The seed needs *that slot's* collab server
   already running or its anchored annotations silently degrade to document-level (§12i).
4. Nothing for `public/pdfjs/` — `predev` already copies it on first run.

**Allocation has to be real, not a counter.** Pick the lowest `n` whose three web ports are free
*and* whose `multiblog_<n>` does not exist, then record it; a stored counter drifts the moment a
worktree is removed by hand. Hashing the branch name instead (as barnacle.ai's Supabase script
does) avoids a registry but makes the ports unpredictable, which is worse here specifically
because `.claude/launch.json` is static JSON the preview tool reads literally and cannot follow a
computed port.

**Teardown is half the job.** `git worktree remove` deletes the tree and leaves `multiblog_<n>`
and its `.file-storage/` behind. Without a matching `dropdb` step those accumulate silently, and
the accumulation is invisible until `\l` is long. A `--remove <n>` path belongs in the same
script as the setup path, for the same reason `scripts/test-*.ts` each own their own `delete`.

**Not urgent while there are two slots** — two is the number that fits in your head, and the
manual path is now short. It stops being short at three, and stops working at all the first time
a worktree is created by tooling rather than by hand.

## ESLint stays on 9 and TypeScript on 5 — both gated on `eslint-config-next`

`npm outdated` offers eslint 10 and typescript 7. Neither works yet, and neither is blocked
on us:

- **eslint 10** removed `context.getFilename()`, which `eslint-plugin-react` still calls, so
  `npx eslint .` dies with `contextOrFilename.getFilename is not a function` before linting
  anything ([eslint-plugin-react#4018](https://github.com/jsx-eslint/eslint-plugin-react/issues/4018),
  a dup of #3977). `eslint-plugin-import`, `-react` and `-jsx-a11y` all cap their `eslint`
  peer at `^9` and are pulled in by `eslint-config-next`, so this is not overridable.
- **typescript 7** is blocked separately by `typescript-eslint`'s `<6.1.0` peer.

Both unblock when Next ships a refreshed lint config — **recheck then, not before**.

Worth knowing when weighing it: taking eslint 10 *would* drop the `brace-expansion` audit
count from 9 to 6.
