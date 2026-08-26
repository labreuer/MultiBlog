# MultiBlog — notes for Claude

Multi-author blog with revisions, real-time collab, and quote-anchored comments.

This file is loaded into every session, so it holds **triggers, not mechanisms**: the rule you
need to know you're about to break, and where the reasoning lives. When a pointer below sounds
relevant to what you're touching, read the file — the summary here is deliberately not enough
to re-derive the decision from.

## Where things are written down

| | |
|---|---|
| [PLAN.md](PLAN.md) | Architecture and build order. §10 tracks what's actually built vs. planned. |
| [TODO.md](TODO.md) | Open items carrying enough context to act on directly. |
| [docs/COLLAB.md](docs/COLLAB.md) | How a remark stays attached to a passage while the passage moves — every strategy used, the ones rejected, and how to pick. |
| [docs/YDOC.md](docs/YDOC.md) | The document stack: one Hocuspocus process, the `ydoc*` tables, restarts, IndexedDB. |
| [docs/TIPTAP.md](docs/TIPTAP.md) | TipTap v3 / y-prosemirror / ProseMirror traps. |
| [docs/PDF.md](docs/PDF.md) | The PDF viewer, anchors, file storage, and pdfjs's many non-obvious failures. |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | Who may do what, as tables over roles × visibility × byline. Keywords have their own section: minting vs. applying vs. curating. |
| [docs/EMAIL.md](docs/EMAIL.md) | Resend, the `sendMail()` seam, invites, what's deferred. |
| [docs/DOC_IMPORT.md](docs/DOC_IMPORT.md) | Creating a doc from Markdown — file import and paste box. |
| [docs/ENV.md](docs/ENV.md) | Every environment variable, and the restart-vs-rebuild rule. |
| [docs/DEV_SLOTS.md](docs/DEV_SLOTS.md) | Two working trees side by side: ports, hosts, databases. |
| [docs/DATABASE.md](docs/DATABASE.md) | The Postgres cluster, what 18 doesn't change, migration recipes. |
| [docs/TEST_DATA.md](docs/TEST_DATA.md) | Throwaway scripts, durable sample data, one-shot imports. |
| [docs/BROWSER_PANE.md](docs/BROWSER_PANE.md) | Driving the preview browser (and why to prefer a spec). |
| [STYLE.md](STYLE.md) | Colors, typography, CSS Modules vs. inline, layout, scrollbars. |
| [PERFORMANCE.md](PERFORMANCE.md) | Findings, the perf-logging tool, and how to measure. |
| [CACHING.md](CACHING.md) | Caching behavior and trade-offs (ISR, …). |
| [DEPLOY.md](DEPLOY.md) | Self-managed Linode/Ubuntu deployment. |
| [docs/FAVICON.md](docs/FAVICON.md) | Site icons and manifest. |
| [e2e/README.md](e2e/README.md) · [scripts/integrity/README.md](scripts/integrity/README.md) · [src/app/sign-in/NOTES.md](src/app/sign-in/NOTES.md) | Suite fixtures · integrity checks · auth strategy. |

## Architecture invariants

Each of these has been decided once and is easy to undo by accident. Read the linked section
before changing the behavior it describes.

- **Admin tables are one kit.** `/posts`, `/docs`, `/users`, `/comments`, `/annotations` all
  render through `src/components/table/` plus a per-table `*-query.ts` over
  `src/lib/table-query.ts`. Filters, sort, pagination and the show-deleted toggle live in the
  querystring and are applied in Postgres, never client-side; a new admin table means a
  `*-query.ts` and the kit's hooks, not a fresh `<table>`. Every column sorts — the ones
  Prisma's `orderBy` can't reach go through a **database view keyed 1:1 on the primary key**
  (`post_activity`, `post_metrics`, `doc_metrics`), which Prisma then treats as an ordinary
  to-one relation. Reach for that before denormalizing or re-sorting in JS. The exception is a
  value expensive to *compute* rather than awkward to reach: a view has no `WHERE` to push
  down when sorted through, so it evaluates for every row on every page load — hence `/docs`'
  Length being a stored, trigger-maintained column (`Doc.proseJsonLength`). PLAN.md §16, §16e,
  §16l.
- **Margin notes: only the cards move.** Above 1200px, comments/annotations still pointing at
  live text are `createPortal`ed into a right-hand rail
  (`src/components/margin-notes/`, packing rule in `src/lib/margin-notes-layout.ts`).
  `CommentSection`/`AnnotationSection` stay put below the article and keep the `<h2>`, the
  form, the sort dropdown and every anchorless entry, so one component still owns sort order,
  the `hashchange` effect and the tree. **CSS owns the two-column grid, JS owns only the
  vertical alignment** — don't move the column layout into JS to "simplify", that split is
  what keeps the rail server-rendered in the right place. The `.anchored` class is toggled
  from JS, never from a `@media` block. PLAN.md §18.
- **An annotation's mechanism follows the surface, never the permission.** The doc *editor*
  writes an `annotation` mark into the doc's ydoc and leaves `anchorFrom`/`anchorTo`/
  `quotedText` null; either *reading* view writes those three columns and never touches the
  document. A row has one or the other, never both — a null `anchorFrom` *is* "look for a mark
  instead". Don't "unify" them by giving the reading views the mark back: that write is the
  thing being removed, not an implementation detail. `resolveAnnotationRanges`
  (`src/lib/annotation-marks.ts`) is the one function that answers for both, and every rail and
  jump target goes through it rather than knowing there are two. PLAN.md §13o, docs/COLLAB.md.
- **One anchor row shape, per-consumer tables.** `keyword_anchor` (and, from PR 2,
  `annotation_anchor`) share a column shape by *compiler*, not by convention:
  `src/lib/anchors/` holds the target arc as a discriminated union, `parseSelector`, and the
  capture/resolve pair, and every consumer goes through it. The object side is four nullable
  FKs with exactly one non-null, enforced by a hand-written CHECK — so **a new targetable kind
  is a migration** (one column, one index, one CHECK edit, per anchor table), which is the
  cost §20a took on deliberately over an `anchor` table with an owner arc or one W3C-style
  supertable. What is unified is the *envelope*, never the selector: each mechanism keeps its
  own physics, and COLLAB.md's "there is no universal anchor" is unchanged. `src/lib/anchors/`
  is split browser-safe (`index.ts`) vs. server (`capture.ts`) the way `avatar-url.ts` and
  `avatar.ts` are — don't barrel them together. PLAN.md §20a, §20b.
- **A keyword chip is exactly as private as the thing it is on, structurally.** `KeywordChips`
  renders only from inside a page that has already run its own gate and takes a resolved
  `AnchorTarget` rather than a slug, so it can't be mounted on an ungated surface; it
  deliberately adds no second check. It also reads **no session** — `/[slug]` is statically
  generated, and a dynamic API there throws at build (§12f) — so everything viewer-shaped
  lives in a client island that asks the server on open. `/keyword/[slug]` is three per-type
  queries wearing three existing predicates, never one UNION. PLAN.md §20d, docs/PERMISSIONS.md.
- **Never position a doc annotation off `Doc.proseJson`.** It's a store-debounce snapshot,
  stale by seconds while anyone is typing. Fine as the *seed* for which cards start in the
  rail, and nothing more.
- **A reply's anchor points into its parent annotation's body, not the doc** — same three
  columns, different target ydoc, different update log (`ydoc:annotation:<parentId>`).
  `postAnnotation` picks the target from `parentAnnotationId` rather than taking it as an
  argument. PLAN.md §13p.
- **`Annotation.ydocUpdateId` is the version the annotator was looking at**, not the log's tail
  at post time, and `quotedText` is derived server-side against exactly that state — so
  replaying reproduces the quote by construction. `scripts/integrity/check-annotation-anchors.ts`
  verifies the arrangement still holds. PLAN.md §13n, §13q.
- **A PDF anchor cannot drift**, because a file's `sha256` is its identity — no tracking
  plugin, no re-resolution, no version stamp. Don't reach for the doc side's drift machinery.
  The one thing that *can* invalidate a stored anchor is our own normaliser, so bump
  `NORMALISER_VERSION` (`src/lib/pdf-text.ts`) on **any** behavioural change. docs/PDF.md §4.
- **Bumping `pdfjs-dist` is never routine**, and neither is deleting the test that looks
  trivial. Pinning protects the *API* pdfjs offers, not the JavaScript runtime it assumes
  underneath, and WebKit ships those built-ins late or not at all — so a bump needs
  `npx tsx scripts/probe-engine.ts` and a real Safari, not just the chromium suite. **And
  removing a polyfill needs a measurement from the *oldest* engine the baseline claims, not
  the newest** — `npx tsx scripts/remote-console.ts` against a real phone. One was deleted on
  a Safari 26.6.1 reading and broke the viewer outright on an in-baseline iOS 18.6.2. And
  `e2e/pdf-assets.spec.ts` is the only guard that pdfjs's four runtime asset directories are
  served: `scripts/make-test-pdf.ts` generates text-only PDFs, which exercise no image
  decoder, so no fixture-based test can cover it. docs/PDF.md §10.
- **`router.refresh()` is not a delivery mechanism behind an `ssr: false` boundary.** It is a
  React transition, and during a transition React holds the old UI rather than dropping to a
  fallback — so a render that never commits is completely silent: no error, no spinner, no
  console line, nothing to find. `/pdf/[slug]`'s viewer sits behind `next/dynamic({ ssr: false
  })` and lost roughly half of all posted annotations to this, for as long as it existed, until
  the surface started fetching its own list (`loadPdfAnnotationEntries`, overlaid on the
  server's `entries` prop and keyed on that prop's identity so it stands down the moment a real
  refresh lands). Don't collapse that back into a bare `router.refresh()`, and don't wire the
  reload context into `/doc/[slug]` for symmetry — that surface renders annotations straight out
  of the server tree with no such boundary, which is exactly why the context's default is a
  no-op. The precondition to recognise is a shape rather than a file: **a client island behind
  `ssr: false` whose content arrives only through a refresh.**
  docs/playwright-flakiness.html class 6.
- **A contributor's avatar is bytes in `user_avatar`, not a URL** — a separate table on purpose
  (`/users` queries with `include:` and no `select:`, so an avatar column on `user` would drag
  up to 100 blobs into that payload). `User.image` stays a URL string for the Auth.js adapter;
  `resolveAvatarSrc` prefers the upload. `src/lib/avatar.ts` is server-only; `avatar-url.ts` is
  the browser-safe half. There is deliberately **no "avatar from URL" path** — a server-side
  fetch of a user-supplied URL is SSRF. PLAN.md §17n, §17o.
- **A `PRIVATE` doc is its listed `DocAuthor`s' alone** — no ADMIN/EDITOR bypass. PLAN.md §12e,
  docs/PERMISSIONS.md.
- **The landing page's preamble is the body of whichever `Doc` is titled exactly `FRONT PAGE`**
  (case-insensitive, first-created wins); its own title is never shown. Seed one with
  `npx tsx scripts/seed-front-page.ts`. No `DocVisibility` check — the title alone is what
  makes its body public here. PLAN.md §17c.

## Running

Two development slots — separate working trees, each with its own `.env`, database and
`.file-storage`. Full rationale, and why `DEV_HOST` is not redundant with the ports:
[docs/DEV_SLOTS.md](docs/DEV_SLOTS.md).

| | slot A | slot B |
|---|---|---|
| working tree | `~/Claude/Projects/MultiBlog` | `~/git/MultiBlog` |
| `DEV_HOST` | `localhost` | `b.localhost` |
| `WEB_PORT` (dev) · `+1` (`web-prod`) · `+2` (e2e prod) | 3000 · 3001 · 3002 | 3005 · 3006 · 3007 |
| `COLLAB_PORT` | 1234 | 1235 |
| database | `multiblog` | `multiblog_b` |

- `npm run dev:all` — web (Next.js) + collab (Hocuspocus) via concurrently; one Ctrl+C stops
  both. Individually: `npm run dev`, `npm run collab`.
- `npm run stop:all` — stops a `dev:all` you started, in one command instead of a
  netstat/parent-trace/taskkill dance. Reads this slot's ports, so run it from the tree you
  mean to stop; it will not touch the other slot's servers.
- `.claude/launch.json` defines `web`, `collab` and `web-prod` for the preview tool. Its
  numbers are **slot A's** and cannot be computed — in slot B, drive from `npm run dev:all` and
  open the pane on `http://b.localhost:3005` directly.
- The user often runs `dev:all` themselves. **You may stop it** when the work needs it —
  `npm run stop:all`, then restart via the preview tool. Standing permission, no need to ask
  each time. Prefer attaching to what's already running when that would answer the question,
  since a restart costs a cold recompile and can poison `.next` (see Checks); but a schema
  change or a new Prisma model *requires* the restart, and asking is worse than doing it. Say
  that you did.

## Database

Local **Postgres 18**, one cluster, one database per slot; `psql -U multiblog -h 127.0.0.1 -d
multiblog` connects passwordless. The cluster layout, what Postgres 18 does *not* change, and
the two migration recipes that bite (adding a required column; repairing a checksum after
editing an applied migration) are in [docs/DATABASE.md](docs/DATABASE.md) — read it before
running `prisma migrate dev` on anything unusual.

- **Restarting the Postgres service needs an elevated shell** — ask the user to do it.
- **`npx prisma format` after editing `schema.prisma` — then read what it changed.** It
  rewrites the *whole file*, so on a drifted one it sweeps up every misalignment ever left
  behind and buries your handful of real lines in a hundred cosmetic ones. The file is
  format-clean now, so a run is a no-op plus your own block's realignment; **anything it
  touches outside your edit is pre-existing drift and gets its own commit.**
  `npm run check:schema` is the fail-if-dirty version (`--write` to fix). Why it matters, why
  the obvious `git diff --exit-code` version of that check is wrong, and why `.gitattributes`
  pins this one file to LF: [docs/DATABASE.md](docs/DATABASE.md).
- `npx prisma generate` fails with **EPERM while the dev server runs** (query-engine DLL is
  locked). Stop `dev:all`, generate, restart.
- **Adding a new model needs the dev server restarted, not just regenerated** — and the failure
  doesn't look like a stale client. `next dev` holds the generated `PrismaClient` in module
  memory, so after `prisma migrate dev` adds a model the *running* server still has the client
  from before it existed: `prisma.yourNewModel` is `undefined`, and the first query dies with
  `TypeError: Cannot read properties of undefined (reading 'findMany')` pointing at your own
  query line. Typecheck passes, which makes it read like a logic bug in the code you just
  wrote. Restarting web is the whole fix. Distinct from the EPERM case: that one is generate
  refusing to *write*, this one is a successful write the running process never picks up.
- Generated Prisma client lives at `src/generated/prisma` (gitignored). Import from
  `@/generated/prisma/client` and `@/generated/prisma/enums`.
- **One-off DB scripts can't `require()` the generated client with plain `node -e`** — it's TS
  source, not compiled JS. Write a `.ts` file importing `prisma` from `./src/lib/prisma` (same
  as `server/collab.ts` does), run it with `npx tsx that-file.ts` from the project root, and
  delete it afterward.
- `.env` is never committed. Every variable, and the bare-vs-`NEXT_PUBLIC_` rule that decides
  whether a change needs a restart or a rebuild: [docs/ENV.md](docs/ENV.md).
- Dev account `labreuer@gmail.com` has role ADMIN.

## Checks & verification

### Automated

- Typecheck `npx tsc --noEmit`; lint `npx eslint .`. (ESLint 9 and TypeScript 5 are pinned by
  `eslint-config-next` — TODO.md says why, and why not to try the upgrade yet.)
- `npm run test:unit` — `node --import tsx --test` over `src/**/*.test.ts`. **No new
  dependency**: Node 24 strips types natively and `tsx` resolves the `@/` alias. Sub-second,
  and the right home for exactly one kind of thing — pure functions whose *rejection surface*
  is the point (`src/lib/anchors/`'s `parseSelector`, the target arc, `resolveAnchorInDoc`'s
  three tiers). A table of malformed inputs is not something to drive a browser through, and
  the e2e suite's proof for a pure refactor is a two-minute production build. Don't reach for
  it for anything involving Prisma, a ydoc or the DOM — those have better tools here already.
- `npm run e2e` — the full Playwright suite against a **production build** on `WEB_PORT + 2`
  (builds first; ~2min of suite proper once warm). Prod rather than `next dev` because two
  historical flake classes were dev-server bugs a production build compiles out — the whole
  investigation is [docs/playwright-flakiness.html](docs/playwright-flakiness.html).
  `npm run e2e:dev` is the dev-target loop for iterating on one spec: `WEB_PORT`, one worker,
  reusing a `dev:all` you already have running.
  **Prefer the suite to driving the browser pane by hand** for anything it already covers, and
  for anything worth covering: one command replaces a dozen `read_page`/click round trips, and
  a spec can do the setup *and* the `boundingBox()`/`getComputedStyle` measurement in one
  process. Fixtures create and delete their own throwaway rows. Details and the gotchas that
  bite when writing new specs: [e2e/README.md](e2e/README.md).
  - **On macOS `npm run e2e` doesn't run at all**: its `check-ports` prestep shells through
    `pwsh`, which isn't installed. Use `npx playwright test` directly there. `npm run stop:all`
    is unavailable for the same reason — use `pkill -f "next dev"` and
    `pkill -f "server/collab.ts"`.
  - **The worker count is derived from the machine**; `E2E_WORKERS` overrides it (docs/ENV.md).
    Too many workers looks like scattered failures across unrelated specs that all pass
    single-worker and read exactly like real regressions.
- **A killed `next dev` can poison `.next/dev` so the *next* start hangs mid-compile.** Symptom:
  the server logs `✓ Ready`, serves `/` fine, then prints
  `○ Compiling /api/auth/[...nextauth] ...` and never finishes — so `/sign-in` hangs and every
  spec dies in `auth.setup.ts` with `page.goto: net::ERR_ABORTED` or a 60s timeout. It reads
  exactly like an auth regression and isn't one. `rm -rf .next` is the whole fix
  (`Remove-Item -Recurse -Force .next`). Most likely on the run *after* a suite that started
  its own dev server — i.e. when you're bisecting a dependency bump and least want a phantom
  failure. Check `.next/dev/logs/next-development.log` for a `Compiling …` line with no
  matching completion before blaming your changes.

### By hand

- The browser pane is for behavior the suite doesn't cover, or when you need to *look* at
  something rather than assert on it. **Don't reach for it — or for the e2e suite — on UI work
  unprompted**; Conventions below says when it comes up instead. Screenshots time out in this
  environment, `ref` clicks can silently no-op, and all tabs share one cookie jar:
  [docs/BROWSER_PANE.md](docs/BROWSER_PANE.md).
- Throwaway users/docs/posts/comments/files/keywords/ydocs, the durable `@sample.invalid` seed,
  and the two one-shot importers: [docs/TEST_DATA.md](docs/TEST_DATA.md). Each script's own header
  documents its flags. Defaults: `test-admin@example.com`, role `ADMIN`, password
  `testpass123`.
- Measuring editing latency, stress-testing at realistic size, and A/B-ing against history:
  PERFORMANCE.md's "Measuring by hand".
- Restarting the collab server never duplicates content, and **a doc's `ydoc` row *is* the doc,
  with no fallback to re-seed from** — deleting it and letting it re-seed discards every
  paragraph and annotation the doc ever had. [docs/YDOC.md](docs/YDOC.md).

## Gotchas

The topic-specific ones live with their topic — [docs/TIPTAP.md](docs/TIPTAP.md) for the
editor, [docs/YDOC.md](docs/YDOC.md) for the document stack, [STYLE.md](STYLE.md) for CSS,
[docs/PDF.md](docs/PDF.md) §10 for pdfjs. These are the ones that apply whatever you're
working on.

- **Never call `toLocaleString()`/`toLocaleDateString()` on a date in a `"use client"`
  component.** It reads the *runtime's* locale and timezone, and the App Router renders client
  components on the server too — so it runs once during SSR on the box (UTC) and again during
  hydration in the browser (the reader's zone), producing different text and a React #418
  hydration mismatch that discards and re-renders the whole subtree. Use
  `src/components/LocalTime.tsx`: `<LocalTime value={...} />` by default, or its `useLocalTime`
  hook where an element can't go (inside a template literal, or as an `<option>`'s text, where
  a nested `<time>` is invalid HTML — being a hook it can't be called in a `.map()` either, so
  render a small per-item component, as `YdocDebug`'s `DocOption` does). The identical call in
  a **Server** Component is fine and must not be "fixed" — it's formatted once and shipped as a
  finished string in the RSC payload. A call site whose data arrives from a client-side fetch
  is also fine, since it was never in the SSR HTML. **This class is invisible to every local
  check**, including `npm run e2e` and `web-prod`: locally the dev server and the browser are
  one machine and so always agree. Same reason PLAN.md §13m's collab bug survived to
  production.
- **No hex or named color literal anywhere in `src/`** outside `src/app/globals.css`,
  `src/lib/author-colors.ts`, and the handful named in STYLE.md's Dark theme section. Every
  color is one of `globals.css`'s tokens — `style={{ color: "var(--text-secondary)" }}` is the
  convention for inline styles, not just CSS Modules. STYLE.md has the token list and the grep
  guard.
- **Any new surface rendering post content needs the `.prose` class.** `globals.css`'s
  `* { margin: 0; padding: 0 }` strips default list and blockquote styling everywhere;
  `src/styles/prose.module.css` is what restores it.
- **A text selection settles on `selectionchange`, not `pointerup`.** The reason is
  **shift+arrows, which delivers no pointer event anywhere** — that one is permanent. So
  debounce `selectionchange` and let `pointerup` short-circuit it (`PdfAnnotationSurface`;
  `AnnotationNode` uses a plain timer for the same reason). This entry used to claim iOS
  fires `pointercancel` rather than `pointerup` for a long-press, and that the drag handles
  are native views firing nothing; **both were measured false** on iOS 18.6.2 and iPadOS 18.6
  (2026-08-25, `scripts/remote-console.ts`) — a long-press ends in `pointerup`, and dragging a
  handle emits 76 `pointermove`s with live coordinates. `pointercancel` is real but belongs to
  *scrolling*, which cancels pointers on every touch platform. Keep the `pointerup` path:
  it is live on both devices, not dead code. docs/PDF.md §10.
- **A Next dynamic-route `params` value arrives percent-encoded, not literal.** `getParamValue`
  runs `encodeURIComponent` on every string param before handing it to user code (verified
  against `next@16.2.11`), so a route packing two ids into one segment as `a+b` would see
  `"a%2Bb"` and `.split("+")` would 404 every URL — a `+`-means-space assumption that's true
  for query strings and false here. `/side-by-side/[left]/[right]` (PLAN.md §14c) uses two path
  segments specifically to never need to decode anything.
- **A Server Component handed to a client component as a prop needs a `key` if it has
  siblings** — even though nothing there is a list. A JSX tree passed across that boundary is
  *serialized into the RSC payload* rather than rendered in place, and the Flight server's
  `renderFragment` stamps every keyless element in an array it serializes as "key not yet
  checked". Only a **Server Component** then trips the check, in `renderFunctionComponent`:
  host elements and client references are serialized by other paths and stay silent, so the
  one child that warns is the one that looks least like a list item. The symptom is "Each
  child in a list should have a unique key prop" pointing at a `<div>` whose children are
  plainly static — `/doc/[slug]`'s byline is the live example, and `/pdf/[slug]`'s chips
  escape it only by being a whole prop value with no siblings. **Invisible to every automated
  check here**: `tsc` and `eslint` can't see it, and `npm run e2e` asserts on the DOM, not the
  console. Dev-only, since the production Flight build runs no such validation.
- **A doc link's anchor is a plain JSON blob in Postgres, not a mark in the doc's ydoc** — the
  opposite of an annotation's, and deliberately: a link joins two *different* docs, and no
  single ydoc can hold that. The cost is drift, paid for by re-running `findQuoteOccurrences`
  against the current document on every content change. **Persisting a corrected offset only
  ever happens from a column in *write* mode** — a read column's view is always at least one
  Yjs update behind. PLAN.md §14, §14d.
- **One document stack, one Hocuspocus process, two sub-namespaces within it.** Every
  `documentName` is `ydoc:`-prefixed; `onAuthenticate` rejects anything else outright.
  docs/YDOC.md.

## Conventions

- Commit only when the user explicitly asks. Commit messages explain *why*, not just what.
- **Don't test UI changes unprompted** — no browser pane, no e2e run. Stop at
  `npx tsc --noEmit` and `npx eslint .`, report the change as done, and say that UI testing
  was deferred.
- **But before committing a change that touched the UI, ask whether to test it first** — if
  it hasn't been tested already. The commit is the moment the question is worth asking, and
  the answer is the user's; don't quietly commit untested UI, and don't quietly go test it
  either.
- Flag deviations from PLAN.md and judgment calls explicitly when reporting work.
