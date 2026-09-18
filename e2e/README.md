# End-to-end tests

Playwright, driving the real app against the real local Postgres. Covers the
flows that otherwise get re-verified by hand every session: publish/unpublish,
comment moderation, two-author live collaboration, quote anchoring across
publishes, republishing from an earlier point in a doc's history,
selecting text on each of the three surfaces that respond to it
(`text-selection.spec.ts`), the date archives and the byline's date link
(`date-archive.spec.ts`, PLAN.md §21h), and /dashboard's session refresh
(`src/app/sign-in/NOTES.md`) — the one flow whose whole point is that a change
is *not* visible until the right page is visited.

```bash
npm run e2e        # full suite, against a production build on :3002 (WEB_PORT + 2)
npm run e2e:dev    # the dev-server target (:3000 = WEB_PORT), one worker by default
```

The full suite targets `next build` + `next start` rather than `next dev`
because two of the suite's historical failure classes were dev-server bugs that
a production build compiles out — the prerender-manifest tear
(vercel/next.js#96664) and next-auth's dev-only SessionProvider invariant 500.
The whole investigation, with rates and mechanisms:
[docs/playwright-flakiness.html](../docs/playwright-flakiness.html). The dev
target remains the fast loop for a spec or feature under active development
(no build step, HMR-warm server); its `devServer500Watch` fixture annotates a
red test whose 500 matches a known dev-only class so it doesn't read as an app
regression.

Other entry points: `npm run e2e:ui` (watch mode with a time-travel debugger),
`npm run e2e:report` (last run's HTML report), and the usual Playwright flags,
forwarded after `--`: `npm run e2e -- e2e/doc.spec.ts -g "title"`,
`--repeat-each=3`, `--headed`, `--debug` (`npm run e2e:dev -- …` for the dev
target; a bare `npx playwright test …` is dev-target too, unless you set
`E2E_TARGET=prod` yourself to point it at :3002).

A subset run is a whole run at the edges: a file or `-g` filter selects spec
tests, and Playwright adds `auth.setup.ts` and `cleanup.teardown.ts` because
they are the selected project's `dependencies` and its `teardown` — `--list`
on a single spec shows all three files. So a one-spec run signs in fresh and
sweeps up after itself, and `e2e/.auth/admin.json` need not exist beforehand.
`--no-deps` skips both, and then it must.

## How a run is wired

1. `playwright.config.ts`'s `webServer` brings up the web server — for the
   prod target `npm run e2e:web` (a `next build`, then `next start` on :3002
   with `AUTH_URL`/`APP_URL`/`E2E_REVALIDATE` set — see `scripts/prod-web.ts`),
   for the dev target `npm run dev` (:3000) — plus `npm run collab` (:1234),
   **unless something is already listening**, in which case it reuses them. A
   `dev:all` you started yourself is never killed, and an `npm run e2e:web`
   left running skips the rebuild on every later `npm run e2e`. (Playwright
   kills servers *it* started at run end, so back-to-back cold runs each pay
   the build.)
2. The `setup` project (`auth.setup.ts`) creates `e2e-admin@example.com`, signs
   in through the real form once, and writes the cookie jar to
   `e2e/.auth/admin.json` (gitignored). It then opens one throwaway doc's
   editor to warm that route's compile and prove the collab server answers —
   `next dev` compiles on first request, and without this every worker hits the
   heaviest route cold at once and can overrun `waitForDocCollabReady`. There's
   no equivalent warm-up for `/post/[id]/edit` any more: it has no collab
   connection of its own (PLAN.md §15 — it publishes, it doesn't edit).
3. Every test in the `chromium` project starts from that storage state — already
   signed in, no sign-in cost per test.
4. The `cleanup` teardown project sweeps any leftover `e2e-*@example.com` users,
   `E2E …` posts/docs and orphaned commenters.

The suite proper, against the prod target with the servers already warm (a
cold `npm run e2e` adds the `next build` on top):

| machine | OS | workers | tests | wall | measured |
|---|---|---|---|---|---|
| Intel i7-8700K, 6 cores / 12 threads, 32 GB | Windows | 2 | 160 | ~2 min | 2026-08-24 |
| AMD Ryzen 9 9950X, 16 cores / 32 threads, 96 GB | Fedora 44 | 8 | 206 | ~40 s | 2026-09-01 |

Postgres and the collab server ran on the same machine in both cases.

**Every timing in this file names the machine it was measured on**, because a
wall-clock figure with no rig attached cannot be checked by the next person to
read it. The figure had already been wrong twice before that was made a rule:
"just under 3 minutes" was itself a correction of an older "~50 seconds".
Treat every number here as dated, and re-measure rather than infer. See the
worker-count note below before raising the parallelism.

## Firefox and WebKit

The suite runs on chromium by default. The other two engines exist as projects
that only come into being when their env var is set, so a bare
`playwright test` never picks them up — doubling the wall clock of the
everyday run buys almost nothing when the job is catching regressions in our
own logic:

```bash
npm run e2e:firefox    # or: npm run e2e -- --project=firefox
npm run e2e:webkit     # or: npm run e2e -- --project=webkit
```

`scripts/e2e.ts` sets `E2E_FIREFOX` / `E2E_WEBKIT` from the `--project` it was
handed, so the flag is the whole command. Driving `npx playwright test` by hand
bypasses that and needs the variable in front, or Playwright reports
"Project(s) 'webkit' not found" — a flag naming the thing it then denies
exists. Both take the usual filters: `npm run e2e:firefox -- e2e/doc.spec.ts`.

**What each is for.** Firefox is Gecko, for the differences chromium cannot
surface — chiefly contenteditable selection and `beforeinput`, where
ProseMirror diverges most. WebKit is for the one class of bug no amount of
chromium coverage can reach: the PDF surface runs pdfjs, and pdfjs uses modern
built-ins WebKit ships late or not at all (two have already bitten an iPad —
`Map.prototype.getOrInsertComputed` and `ReadableStream`'s async iterator, both
patched in `src/lib/pdfjs-webkit-polyfills.ts`). Neither is iPadOS Safari:
Playwright drives its own builds, so the native selection gestures an iPad uses
are still unreproducible here. What WebKit shares is the JS engine, which is
where those two bugs live.

It is not desktop Safari either, and the gap is measurable rather than
theoretical: the popover fix in the list below was written against a selection
expansion that Playwright's WebKit build performs and Safari 26.6.1 does not.
When a webkit finding needs confirming in the real thing, [MACOS.md](MACOS.md)
has the recipe for driving Safari.app from a session — no WebDriver, and no
permission grant for the read-only half.

### First-time setup

```bash
npm run setup:browsers      # downloads chromium, firefox and webkit builds
```

Firefox then runs as downloaded. **WebKit on Fedora needs two more steps**,
because Playwright ships no Fedora WebKit build and falls back to the Ubuntu
24.04 one:

```bash
npm run setup:webkit-libs   # stages Ubuntu's libicu74 + libjpeg8 into .playwright-libs/
sudo dnf install libmanette # the one dependency Fedora does package
```

The libraries go **into the WebKit bundle's own `sys/lib`**, which is where
that bundle already keeps the distro libraries it declines to depend on the
host for. Nothing is installed system-wide, so no other program on the machine
ever loads an ICU three majors behind. `LD_LIBRARY_PATH` is the obvious reach
and is **wrong**: the bundle's launcher assigns the variable rather than
appending to it, so a value set around the run is gone by the time the ELF
loader reads it — and it fails late, passing Playwright's own pre-flight check
(which reads the same variable) and then dying in every single
`browserType.launch`. `scripts/webkit-libs.ts` has that account in full,
including why a symlink to the system ICU is not an option.

`playwright install --force webkit`, or a bump that pulls a new webkit
revision, wipes the staged files; re-run `npm run setup:webkit-libs`, which
keeps its downloads and so only re-copies.

Playwright's pre-flight `ldd` check asks for a third thing,
`gstreamer1.0-libav` — really `libx264.so`, which is h.264 playback, dlopen'd
at need and on no path any spec here takes. On Fedora that means enabling RPM
Fusion Free for a codec nothing plays, so the config instead sets
`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS` — but only once it has confirmed
the staging *and* libmanette itself, so the check stays on in every state where
it would have told you something true. `webkitLaunchEnv()` is the whole rule.

### Where each engine stands

Measured 2026-09-14 on the Ryzen 9 9950X / Fedora 44 box, prod target, 8
workers, servers warm. The middle column is what the engines *found* — every
one of these was a defect or a wrong assumption, not an engine quirk to route
around, and five of them were live on chromium too:

| project | now | at first run | wall |
|---|---|---|---|
| chromium | 261 / 0 | 258 / 2 | 61–76 s |
| firefox | 251 / 0 | 242 / 8 | 76–77 s |
| webkit | 250 / 0 | 158 / 92 | 85–135 s |

What the 92 + 8 turned into, each its own commit: a lost-update race in
`useLiveDocContent`'s hoisted branch; a failed session fetch read as a dead
session; a popover reopening over text Playwright's WebKit re-selected under
it (Safari itself does not re-select — [MACOS.md](MACOS.md)); a suite
that raced every `router.refresh()`; a clipboard read no engine but chromium
allows; a pinch gesture nothing had ever tested; and Firefox serving post
pages out of its own HTTP cache (CACHING.md, 2026-09-14).

**A red in firefox or webkit is still not a release blocker** the way a
chromium one is — it is a finding to triage. Firefox has now had the same
worker matrix chromium got (3 rounds × {2, 4, 6, 8, 10}, prod target, warm
servers, 2026-09-14; the table is in docs/playwright-flakiness.html's
follow-up of that date): **8 is right for it too**, no count from 4 up moved
the red rate, and every red was a specific fault the load merely widened —
none was contention. Four were the suite's and are fixed where they sit
(`signedInContext` in fixtures.ts had no `Cache-Control: no-cache`, and
tighten, link-bubble and doc-settings-collapse each gained a wait that says
why). What is left is not the suite's to fix:

- **The session cookie can be put back by a request that started before the
  sign-in.** Auth.js re-issues `authjs.session-token` on every `GET
  /api/auth/session`, so a GET in flight across the credentials POST — or
  across the POST that clears a dead session — answers a few milliseconds
  later and wins. Seen as `files.spec.ts:194` rendering `/files` as the admin
  after signing in as another user, and `session-refresh.spec.ts:108` keeping
  a deleted user signed in; each about once in five under load.
  src/app/sign-in/NOTES.md has the measured sequence, TODO.md the options.
- **A navigation Playwright believes is still in flight.** The call log ends
  in `waiting for "…" navigation to finish...`, the element is on the page,
  and the action waits out the whole expect budget: Firefox reported a
  navigation that it never committed or aborted, and Playwright's pre-action
  check holds every later action until it does. One trigger is known and
  closed — a prerendered page answered from Firefox's cache while its
  stale-while-revalidate refetch registered as a second document request,
  which the `no-cache` header prevents (CACHING.md, 2026-09-14) — but
  `link-bubble.spec.ts:415` reached the same state once after an Enter with
  nothing on the wire, so it is not gone. `PLAYWRIGHT_SKIP_NAVIGATION_CHECK=1`
  turns the check off if it recurs; TODO.md has the upstream note.
- **`doc-settings-collapse.spec.ts:48`, about one run in sixteen.** The
  panel's smooth `scrollIntoView` on toggle never lands, so the body stays
  painted over the summary — the very bug the test guards, real and
  intermittent on Firefox under load. The probe polls for 10 s now and reports
  where the summary was; a red here is the app, not the wait. TODO.md.
- **`anchored-link-editing.spec.ts:291`, once at 10 workers**: the file bytes
  answered 503 "File contents are missing" 700 ms after the row was created,
  so the row outlived its bytes: every default test PDF has the same bytes
  and so one `sha256`, and `deleteTestFile`'s count-then-sweep of it can
  run between another test's create and its row. Fixture side; TODO.md.

The globe-icon assertion in `link-bubble.spec.ts` is skipped on webkit, and
the touch-pinch test in `pdf-zoom.spec.ts` where `Touch` isn't constructible;
both say why at the call site.

### The sign-in race, and the app behaviour behind it

Worth reading before writing anything that signs in. `SessionRefresh` mounts on
/dashboard and, once per mount, POSTs /api/auth/session and then calls
`router.refresh()`. So **landing on /dashboard is not the end of signing in**:
for a few hundred milliseconds the page still has a navigation of its own
coming, and a test that navigates inside that window races it. WebKit loses the
race outright — `page.goto` dies with "interrupted by another navigation" —
which was **84 of the webkit project's first 92 failures, across 21 specs**.
`signIn()` now waits that window out; the comment there records which waits
were measured and what each cost.

The part that was *not* a test artifact: a navigation aborts that POST,
`update({})` swallows the fetch error and resolves `null`, and SessionRefresh
read null as "this session just died". A signed-in reader who clicked a link
within a moment of reaching /dashboard — or whose network merely dropped that
one request — was bounced to the sign-in page with a perfectly good session.
SessionRefresh now confirms with a second request before acting, and says
nothing if that one fails too.

## Fixtures

From `./fixtures` (import `test` and `expect` from there, not from
`@playwright/test`):

| Fixture | What you get |
| --- | --- |
| `draftPost` | An unpublished post by the shared admin, backed by its own throwaway doc with real body text |
| `publishedPost` | Same, already published, so its public page (`post.path`, `/yyyy/mm/dd/slug`) and comments work |
| `publishedModeratedPost` | Published with `moderationPolicy: ALWAYS` |
| `quotedPost` | Published with `QUOTED_BODY` and one ACTIVE quote thread |
| `draftDoc` | A PRIVATE doc by the shared admin, empty |
| `sharedDoc` | A SHARED doc, body `QUOTED_BODY` — readable/annotatable by any AUTHORIZED+ reader |
| `secondUser()` | A second signed-in identity **in its own browser context** |

A `TestPost` (PLAN.md §15) carries `docId` alongside `id`/`slug`/`title` —
editing its content means navigating to `/doc/${post.docId}/edit`, not the
post's own edit page, which only publishes.

It also carries `path`, the public page (`/yyyy/mm/dd/slug`, PLAN.md §21) — a string on the
published fixtures, null on `draftPost`. The date segment *is* `publishedAt`, so a post the
*browser* publishes has no knowable path until afterwards: read it back with
`getPostPath(post.id)` (`publish.spec.ts`'s `publicPath`), never by formatting "today" — that
crosses midnight in UTC eventually and reads exactly like a regression.

DB helpers worth knowing beyond the fixtures (all from `./db`):
`getCommentFacts()`, `getAnnotationEditFacts()`, `backdateComment()`,
`backdateAnnotationPosting()`, `setAnnotationEditingSince()`.

Plus helpers: `bodyEditor(page)`, `titleEditor(page)`, `statusLine(page)`,
`visibleText(page, text)`, `deleteTextInBody(page, needle)`,
`selectTextInBody(page, needle)`, `collapseToBodyStart(page)` (never
`Ctrl+A`+`ArrowLeft` — its comment explains the keystroke race that wiped
whole documents), `waitForDocCollabReady(page)`, `freshGoto(page, path)` (for
asserting on direct-DB writes on an ISR page against the prod target),
`signIn(page, email)`.

Each fixture deletes what it created. Nothing is shared between tests except
the admin account.

## Things worth knowing before adding a test

- **Wait for `waitForDocCollabReady`, not for the editor to render**, when
  driving a doc's editor. `DocEditor`'s live content is legitimately empty
  until the Hocuspocus provider has synced, and typing before then edits a
  `Y.Doc` that's about to be overwritten by the real seed. `🟢 Live` is the
  earliest point at which acting on the editor means anything. On
  `/post/[id]/edit` there's a different readiness gate instead: Publish/
  Schedule stay disabled until `PostSnapshotScrubBar` has loaded the backing
  doc's history — `await expect(page.getByRole("button", { name: "Publish",
  exact: true })).toBeEnabled()`. **That gate never opens for a viewer without
  edit access to the backing doc** (PLAN.md §15i): the bar is not mounted at
  all, so a spec driving such a user must wait on the post's stored content
  instead — `publish.spec.ts`'s "a post author with no edit access to the
  source doc…" is the worked example. A post's byline and its doc's byline are
  independent, so this is an ordinary fixture setup, not an exotic one.
- **`waitForDocCollabReady` cannot be used in the doc editor's phone-landscape
  focus mode.** It waits for the connection badge to be *visible*, and that
  badge is one of the things the mode hides (STYLE.md's fourth breakpoint), so
  it times out at a short-landscape viewport no matter how ready the editor is.
  `margin-rail-widths.spec.ts` loads and waits at a desktop size first and then
  resizes, which is also the honest case — a phone opening a doc that already
  has annotations on it.
- **Comments are rate-limited to 5 per IP per 10 minutes**
  (`src/lib/rate-limit.ts`), and every worker shares 127.0.0.1. Create comments
  with `createComment()` (straight to the DB) unless the test is *about* the
  submission form; `moderation.spec.ts` has exactly one that is. Editing has its
  own limiter (`isCommentEditRateLimited`, 5 revisions per user per 10 minutes),
  which is per *user* rather than per IP — so parallel workers don't share it,
  but a single test making six edits as the shared admin would.
- **A fixture comment or annotation comes with its revision 1** (PLAN.md §22).
  `createComment()` and `createTestAnnotation()` write it, and the annotation one
  also seeds the body's ydoc from `bodyText`. Both matter: without the ydoc, an
  edit session connects to a document Hocuspocus helpfully auto-creates *empty*
  and the first Done tries to settle that emptiness (refused); without version 1
  — a `ydoc_snapshot` of the seed — and `postedAt` there is no settled state to
  cancel back to, nothing for the grace window to be measured from, and
  `check-annotation-snapshots.ts` reports every leftover row.
- **`createComment()` links the commenter to a `User` when one exists with that
  email.** Pass `ADMIN_EMAIL` and the comment is the signed-in admin's *own*, which
  is what makes "edit your own comment" reachable at all — an anonymous commenter
  cannot edit (§22h), so a fixture with an unowned address is testing the
  moderator path instead. An email belonging to no user still produces an
  anonymous commenter.
- **The three-minute edit window is not tested with `page.clock`.** §22b's silence
  rule compares two *stored* timestamps — when a version was superseded, against
  when the thing was posted — and never reads a clock, so moving the browser's
  time forward changes nothing whatsoever. What decides the outcome is the interval
  between posting and editing: `backdateComment()` and
  `backdateAnnotationPosting()` produce it directly. `setAnnotationEditingSince()`
  is the same trick for the abandoned-session UI, whose window is an hour.
  A spec asserting "no marker appeared" should also assert on
  `getCommentFacts()` / `getAnnotationEditFacts()`: a silent edit still writes a
  version, so the UI assertion alone passes just as well against an
  implementation that threw the old version away.
- **`"Publish"` also matches "Publish as blog post" on `/doc/[slug]`.** Use
  `exact: true`.
- **`getByRole("button", { name: "Next" })` also matches Next.js's dev-tools
  button.** The pagination controls are `"◀ Prev"`/`"Next ▶"`; match them with
  `exact: true` on the full label, arrows included.
- **An admin table's row can hold several textboxes.** A `/users` row has three
  (name, initials, colour), so `row.getByRole("textbox")` trips strict mode —
  scope to a cell first. `admin-table.spec.ts` does this, and is the place to
  add coverage for anything in the shared table kit (PLAN.md §16): it asserts
  the row-status border by *computed colour* rather than class name, so it
  fails if the palette is changed without meaning to.
- **Filter/sort/page-size changes are `router.replace` navigations**, and the
  search box debounces 400ms before firing one. Assert with
  `await expect(page).toHaveURL(...)` (which retries) rather than reading
  `page.url()` straight after the interaction.
- **Public post bodies exist twice in the DOM.** `AnnotatableArticle` keeps a
  static server-rendered copy and an interactive one, toggling `display` between
  them — so a bare `getByText` trips strict mode and `.first()` can land on the
  hidden copy. Use `visibleText()`. `selectTextInBody()` is unaffected: it
  resolves through the `aria-label`, which only the interactive copy carries.
- **Selecting text is covered per-surface in `text-selection.spec.ts`**, and
  new selection behaviour belongs there rather than spread across the three
  specs that own each page. All three surfaces reach the same gesture through
  genuinely different machinery (COLLAB.md §1/§4/§5) while failing
  identically from the outside — "no widget appeared" — so keeping them
  adjacent is what makes the odd one out visible. That file's header records
  the shipped bug it exists for: `/doc/[slug]/edit`'s widget could not open at
  all, and nothing caught it because the existing coverage of that page
  *types* into the editor and never selects in it.
- **Selection popovers are addressed by test id**, not by their buttons:
  `comment-popup` (post reading view) and `annotation-popup` (both doc
  surfaces). Every page carrying one also renders a second composer below the
  article whose buttons are named identically, so an unscoped
  `getByRole("button", { name: "Post comment" })` trips strict mode. Scope to
  the popup and assert with `toContainText` from there.
- **Deleting the quoted text does not collapse a quote's anchor range.**
  `recreateTransform` diffs at character level, so removing exactly the quoted
  words still leaves the mapped end one character past the start, paired against
  whatever followed. That case detaches on the `quotedText` comparison, the same
  branch as an edit *inside* the quote; reaching the `mappedTo > mappedFrom`
  guard takes deleting past the quote's boundary. `quote-anchoring.spec.ts`
  covers both, and its header records the exact mapped positions.
- **A DETACHED thread can reattach on a later publish**, if the article's text
  at its frozen anchor matches its `quotedText` again — most directly, scrubbing
  the backing doc back to the position it was frozen against and republishing
  from there (PLAN.md §15, the direct successor to "restore a revision").
  `quote-anchoring.spec.ts`'s last test drives that full loop: quote →
  invalidate → detach → scrub back → republish → assert ACTIVE again on the
  public page. `remapThreadsToEvent` (`src/lib/anchor-remap.ts`) excludes
  DETACHED from its query entirely on its own, so this never happens no matter
  what a later publish says *unless* something actually republishes from the
  matching point — there is no automatic reattachment.
- **Playwright aborts every request whose URL ends in `/favicon.ico`** — in every
  browser, before `page.route` or the request events see it (playwright-core's
  `requestStarted`, `_isFavicon`). An `<img src="https://any.host/favicon.ico">`
  fires `error` with no request ever made and nothing to intercept, and it reads
  exactly like a CSP or an app bug; it is neither. `link-bubble.spec.ts` covers
  the link bubble's icon through its own-site `<link rel="icon">` branch for that
  reason, and the globe it shows for a third-party site there is what *every*
  third-party site yields under Playwright, routed or not.
- **Use `gotoOk(page, path)` rather than asserting on `response.status()`.** A
  bare status assertion reports only the number, and when Playwright reuses an
  already-running dev server that server's console output isn't captured
  either — so a 500 tells you nothing. `gotoOk` puts the response body in the
  failure message, which is how the flake below was finally identified.
- **The defaults are derived, not typed in, and raising the ceiling needs a
  fresh matrix.** `playwright.config.ts` holds a table of *measured* machines
  (12 threads → 2 workers, 32 threads → 8) and picks the largest row this
  machine matches, scaling down below the smallest; the dev lane is a hard 1
  because its limit is the dev server serializing SSR rather than the CPU.
  `E2E_WORKERS` in `.env` overrides either (never committed, so it stays
  per-machine). Three matrices sit behind that (docs/playwright-flakiness.html).
  On **dev**, request p50/p99 roughly doubled per added worker for the same
  ~200s wall clock — extra workers bought tail latency, not speed. On **prod**
  the speed is real (3 workers ~13% quicker, 4 ~18% on the 12-thread box) but
  so is the price: p50 climbed 30-55%, and above 2 workers a run's slowest test
  began crossing the 10s expect budget, with one contention red in each of the
  3- and 4-worker rounds and none at 2. On the 32-thread box, 8 workers is ~24%
  quicker than 4 and 16 is no quicker than 8 while its slowest test closes on
  the budget. Faster runs are not worth a red that reads like a regression. The
  tell for contention is still that red tests scatter across unrelated specs and
  don't repeat between runs; but note it's no longer a *sufficient* tell in
  reverse — a genuine keystroke race (class 1 in that doc) failed at every
  worker count including 1, and the 32-thread matrix's first pass had **four
  reds, none of them contention**: each was a test-design fault that a faster
  box or more neighbours exposes (a keystroke inside TipTap's
  requestAnimationFrame-deferred `focus()`, a test relying on the `[[` menu's
  *recent* list, a wait keyed on a POST body Playwright no longer had, and a
  `/comments` "no row" check on a sentence another fixture also uses). A red
  that *repeats* on a fast machine is a timing assumption in the test. Two
  historical attributions from this bullet's earlier text were corrected by
  the matrix: the `useSession must be wrapped in a <SessionProvider />` 500s
  are next-auth's dev-only invariant amplified by rebuild windows (impossible
  in the prod build the full suite now targets), and the "server actions
  arriving with truncated bodies" were never truncated bodies at all — the
  `Unexpected end of JSON input` was Next failing to parse its own
  prerender-manifest (vercel/next.js#96664), 500ing the request before the
  action ran.
- **Two users means two browser contexts**, which `secondUser()` handles. Don't
  reach for two tabs: they share a cookie jar, and the second sign-in silently
  re-authenticates the first (the same trap docs/BROWSER_PANE.md documents for the browser
  pane).
- **`sendMail` is never stubbed or spied on.** Every address the suite creates
  is `@example.com`, and `src/lib/mail.ts` refuses to deliver to that domain
  unconditionally, in every environment — a guard in the seam itself, not
  something the suite has to arrange (docs/EMAIL.md §2). A test that needs a
  live invite/reset token reads it straight from the DB (`getInvites`,
  `createTestInvite`) rather than parsing a logged email.
- **`?cols=name,email,invite,inviteUrl`-style params are the reliable way to
  assert on a `defaultHidden` admin-table column.** Membership in `cols` is
  visibility (PLAN.md §16i), so a column that's hidden by default won't appear
  just because a test navigates to the page — force it into the querystring
  rather than relying on the ColumnPicker. `invite.spec.ts` does this for
  `/users`' two invite columns.

## Why the DB helpers run in a child process

`e2e/db-worker.ts` holds the Prisma calls and runs under `tsx`;
`e2e/db.ts` is a thin JSON-over-stdio client. The split exists because
Playwright's TypeScript loader cannot require the generated Prisma client:
`src/generated/prisma/client.ts` uses `import.meta.url`, which has no CJS
equivalent, so Playwright's transform emits CJS that still contains ESM syntax
and Node fails with `exports is not defined`.

One `tsx` child per Playwright worker, spawned on first use, so the ~1.5s
startup is paid once and each later call is a sub-millisecond round trip.
Both files keep the `@example.com`-only guard that `scripts/test-user.ts` and
`scripts/test-post.ts`/`scripts/test-doc.ts` use, so a misfiring test cannot
touch real data.

## Using this to measure, not just to assert

The reason to reach for Playwright over the browser pane isn't only speed — a
spec can do setup *and* measurement in one process, and print numbers:

```ts
test("measure", async ({ page, draftDoc }) => {
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);

  const box = await bodyEditor(page).boundingBox();
  const fontSize = await page.evaluate(
    () => getComputedStyle(document.querySelector("h1")!).fontSize,
  );
  console.log({ box, fontSize });
});
```

For editing-latency work, the `execCommand('insertText')` loop PERFORMANCE.md
describes runs the same way inside `page.evaluate`, timed with
`performance.now()` — one command instead of a keystroke-by-keystroke drive
through the browser pane.
