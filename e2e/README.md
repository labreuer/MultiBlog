# End-to-end tests

Playwright, driving the real app against the real local Postgres. Covers the
flows that otherwise get re-verified by hand every session: publish/unpublish,
comment moderation, two-author live collaboration, and quote anchoring across
revisions.

```bash
npm run e2e
```

Other entry points: `npm run e2e:ui` (watch mode with a time-travel debugger),
`npm run e2e:report` (last run's HTML report), and the usual Playwright flags —
`npx playwright test e2e/collab.spec.ts -g "title"`, `--headed`, `--debug`.

## How a run is wired

1. `playwright.config.ts`'s `webServer` brings up `npm run dev` (:3000) and
   `npm run collab` (:1234) — **unless something is already listening**, in
   which case it reuses them. A `dev:all` you started yourself is never killed.
2. The `setup` project (`auth.setup.ts`) creates `e2e-admin@example.com`, signs
   in through the real form once, and writes the cookie jar to
   `e2e/.auth/admin.json` (gitignored). It then opens one throwaway post's
   editor to warm that route's compile and prove the collab server answers —
   `next dev` compiles on first request, and without this every worker hits the
   heaviest route cold at once and can overrun `waitForCollabReady`.
3. Every test in the `chromium` project starts from that storage state — already
   signed in, no sign-in cost per test.
4. The `cleanup` teardown project sweeps any leftover `e2e-*@example.com` users,
   `E2E …` posts and orphaned commenters.

The whole suite runs in roughly 50 seconds on 2 workers — see the worker-count
note below before raising that.

## Fixtures

From `./fixtures` (import `test` and `expect` from there, not from
`@playwright/test`):

| Fixture | What you get |
| --- | --- |
| `draftPost` | An unpublished post by the shared admin, with real body text |
| `publishedPost` | Same, already published, so `/[slug]` and comments work |
| `publishedModeratedPost` | Published with `moderationPolicy: ALWAYS` |
| `quotedPost` | Published with `QUOTED_BODY` and one ACTIVE quote thread |
| `secondUser()` | A second signed-in identity **in its own browser context** |

Plus helpers: `bodyEditor(page)`, `titleEditor(page)`, `statusLine(page)`,
`visibleText(page, text)`, `deleteTextInBody(page, needle)`,
`waitForCollabReady(page)`, `signIn(page, email)`.

Each fixture deletes what it created. Nothing is shared between tests except
the admin account.

## Things worth knowing before adding a test

- **Wait for `waitForCollabReady`, not for the editor to render.** `PostEditor`
  disables Save/Publish/Schedule until the Hocuspocus provider has synced,
  because before that the local `Y.Doc` is legitimately empty and a save would
  persist that emptiness over the real content. `🟢 Live` is the earliest point
  at which acting on the editor means anything.
- **Comments are rate-limited to 5 per IP per 10 minutes**
  (`src/lib/rate-limit.ts`), and every worker shares 127.0.0.1. Create comments
  with `createComment()` (straight to the DB) unless the test is *about* the
  submission form; `moderation.spec.ts` has exactly one that is.
- **`"Publish"` also matches the Unpublish button.** Use `exact: true`.
- **Public post bodies exist twice in the DOM.** `AnnotatableArticle` keeps a
  static server-rendered copy and an interactive one, toggling `display` between
  them — so a bare `getByText` trips strict mode and `.first()` can land on the
  hidden copy. Use `visibleText()`.
- **Deleting the quoted text does not collapse a quote's anchor range.**
  `recreateTransform` diffs at character level, so removing exactly the quoted
  words still leaves the mapped end one character past the start, paired against
  whatever followed. That case detaches on the `quotedText` comparison, the same
  branch as an edit *inside* the quote; reaching the `mappedTo > mappedFrom`
  guard takes deleting past the quote's boundary. `quote-anchoring.spec.ts`
  covers both, and its header records the exact mapped positions.
- **Use `gotoOk(page, path)` rather than asserting on `response.status()`.** A
  bare status assertion reports only the number, and when Playwright reuses an
  already-running dev server that server's console output isn't captured
  either — so a 500 tells you nothing. `gotoOk` puts the response body in the
  failure message, which is how the flake below was finally identified.
- **Don't raise `workers` above 2.** Three overloads the dev server rather than
  the machine, and the failures look like app bugs but aren't: a public page
  500ing with next-auth's `useSession must be wrapped in a <SessionProvider />`
  during SSR (the root layout *does* wrap `{children}`, and next-auth guards
  that throw so it can't fire in production), and server actions arriving with
  truncated bodies — `Unexpected end of JSON input` on `/posts/[id]/edit`,
  which leaves the clicked action silently not applied. Neither reproduces in
  isolation. Measured: ~1 failed run in 3.5 at three workers, 0 in 8 at two,
  for the same ~50s wall clock, because the dev server is the bottleneck.
- **Two users means two browser contexts**, which `secondUser()` handles. Don't
  reach for two tabs: they share a cookie jar, and the second sign-in silently
  re-authenticates the first (the same trap CLAUDE.md documents for the browser
  pane).

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
`scripts/test-post.ts` use, so a misfiring test cannot touch real data.

## Using this to measure, not just to assert

The reason to reach for Playwright over the browser pane isn't only speed — a
spec can do setup *and* measurement in one process, and print numbers:

```ts
test("measure", async ({ page, draftPost }) => {
  await page.goto(`/posts/${draftPost.id}/edit`);
  await waitForCollabReady(page);

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
