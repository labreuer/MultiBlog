# End-to-end tests

Playwright, driving the real app against the real local Postgres. Covers the
flows that otherwise get re-verified by hand every session: publish/unpublish,
comment moderation, two-author live collaboration, quote anchoring across
publishes, republishing from an earlier point in a doc's history,
selecting text on each of the three surfaces that respond to it
(`text-selection.spec.ts`), and /dashboard's session refresh
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
`npm run e2e:report` (last run's HTML report), and the usual Playwright flags —
`npx playwright test e2e/doc.spec.ts -g "title"`, `--headed`, `--debug` (all
dev-target; set `E2E_TARGET=prod` yourself to point one at :3002).

## How a run is wired

1. `playwright.config.ts`'s `webServer` brings up the web server — for the
   prod target `npm run e2e:web` (a `next build`, then `next start` on :3002
   with `AUTH_URL`/`APP_URL`/`E2E_REVALIDATE` set — see `scripts/e2e-web.ps1`),
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
   no equivalent warm-up for `/posts/[id]/edit` any more: it has no collab
   connection of its own (PLAN.md §15 — it publishes, it doesn't edit).
3. Every test in the `chromium` project starts from that storage state — already
   signed in, no sign-in cost per test.
4. The `cleanup` teardown project sweeps any leftover `e2e-*@example.com` users,
   `E2E …` posts/docs and orphaned commenters.

The suite proper runs in about 2 minutes against the prod target at 2 workers
(160 tests, measured 2026-08-24 with the servers already warm). A cold
`npm run e2e` adds the `next build` on top.

**Every timing in this file was measured on one machine** — an Intel i7-8700K,
6 cores / 12 threads, Windows, with Postgres and the collab server on the same
box — and that is worth stating rather than assuming, because a wall-clock
figure with no rig attached cannot be checked by the next person to read it.
This one has already been wrong twice: "just under 3 minutes" was itself a
correction of an older "~50 seconds". Treat every number here as dated, scale
it by your own core count, and re-measure rather than infer. See the
worker-count note below before raising the parallelism.

## Fixtures

From `./fixtures` (import `test` and `expect` from there, not from
`@playwright/test`):

| Fixture | What you get |
| --- | --- |
| `draftPost` | An unpublished post by the shared admin, backed by its own throwaway doc with real body text |
| `publishedPost` | Same, already published, so `/[slug]` and comments work |
| `publishedModeratedPost` | Published with `moderationPolicy: ALWAYS` |
| `quotedPost` | Published with `QUOTED_BODY` and one ACTIVE quote thread |
| `draftDoc` | A PRIVATE doc by the shared admin, empty |
| `sharedDoc` | A SHARED doc, body `QUOTED_BODY` — readable/annotatable by any AUTHORIZED+ reader |
| `secondUser()` | A second signed-in identity **in its own browser context** |

A `TestPost` (PLAN.md §15) carries `docId` alongside `id`/`slug`/`title` —
editing its content means navigating to `/doc/${post.docId}/edit`, not the
post's own edit page, which only publishes.

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
  `/posts/[id]/edit` there's a different readiness gate instead: Publish/
  Schedule stay disabled until `PostSnapshotScrubBar` has loaded the backing
  doc's history — `await expect(page.getByRole("button", { name: "Publish",
  exact: true })).toBeEnabled()`.
- **Comments are rate-limited to 5 per IP per 10 minutes**
  (`src/lib/rate-limit.ts`), and every worker shares 127.0.0.1. Create comments
  with `createComment()` (straight to the DB) unless the test is *about* the
  submission form; `moderation.spec.ts` has exactly one that is.
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
- **Use `gotoOk(page, path)` rather than asserting on `response.status()`.** A
  bare status assertion reports only the number, and when Playwright reuses an
  already-running dev server that server's console output isn't captured
  either — so a 500 tells you nothing. `gotoOk` puts the response body in the
  failure message, which is how the flake below was finally identified.
- **The defaults are derived, not typed in, and raising the ceiling needs a
  fresh matrix.** `playwright.config.ts` scales the prod default with
  `os.cpus().length` up to `MEASURED_WORKERS`, so a smaller machine gets fewer
  workers with nothing to edit; the dev lane is a hard 1 because its limit is
  the dev server serializing SSR rather than the CPU. `E2E_WORKERS` in `.env`
  overrides either (never committed, so it stays per-machine). Two matrices sit
  behind that (docs/playwright-flakiness.html). On **dev**, request p50/p99
  roughly doubled per added worker for the same ~200s wall clock — extra workers
  bought tail latency, not speed. On **prod** the speed is real (3 workers ~13%
  quicker, 4 ~18%) but so is the price: p50 climbed 30-55%, and above 2 workers
  a run's slowest test began crossing the 10s expect budget, with one contention
  red in each of the 3- and 4-worker rounds and none at 2. Faster runs are not
  worth a red that reads like a regression. The tell for contention is still that
  red tests scatter across unrelated specs and don't repeat between runs; but
  note it's no longer a *sufficient* tell in reverse — a genuine keystroke
  race (class 1 in that doc) failed at every worker count including 1. Two
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
  re-authenticates the first (the same trap CLAUDE.md documents for the browser
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

For editing-latency work, the `execCommand('insertText')` loop CLAUDE.md
describes runs the same way inside `page.evaluate`, timed with
`performance.now()` — one command instead of a keystroke-by-keystroke drive
through the browser pane.
