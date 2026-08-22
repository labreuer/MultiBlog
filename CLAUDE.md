# MultiBlog — notes for Claude

Multi-author blog with revisions, real-time collab, and quote-anchored comments.
Architecture and build order: [PLAN.md](PLAN.md) — §10 tracks what's actually built vs. planned.
Performance findings and the opt-in perf-logging tool: [PERFORMANCE.md](PERFORMANCE.md).
Caching behavior/trade-offs (ISR, ...): [CACHING.md](CACHING.md).
Styling conventions (colors, typography, CSS Modules vs. inline): [STYLE.md](STYLE.md).
Admin tables (`/posts`, `/docs`, `/users`, `/comments`, `/annotations`) all render through
one kit — `src/components/table/` plus a per-table `*-query.ts` over `src/lib/table-query.ts`.
Filters, sort, pagination and the show-deleted toggle live in the querystring and are
applied in Postgres, never client-side; a new admin table means a `*-query.ts` and the
kit's hooks, not a fresh `<table>`. Every column on every one of them sorts — the ones
Prisma's `orderBy` can't reach (a joined byline, filtered counts) go through a database
view keyed 1:1 on the table's primary key, which Prisma then treats as an ordinary to-one
relation: `post_activity`, `post_metrics`, `doc_metrics`. Reach for that before
denormalizing or re-sorting in JS. The exception is a value expensive to *compute* rather
than merely awkward to reach — a view recomputes per query, and sorting through one has no
`WHERE` to push down, so it evaluates the expression for every row in the table on every
page load. That is why `/docs`' Length is a stored, trigger-maintained column
(`Doc.proseJsonLength`) and not a view column. Rationale, measurements, costs and the
phases still unbuilt: PLAN.md §16 (§16e, §16l).
Above 1200px, comments/annotations that still point at live text sit in a right-hand rail,
each card level with its own passage (PLAN.md §18) — `src/components/margin-notes/` plus
the pure packing rule in `src/lib/margin-notes-layout.ts`. **Only those cards move.**
`CommentSection`/`AnnotationSection` stay put below the article and keep the `<h2>`, the
form/composer, the sort dropdown, and every anchorless entry (general discussion, a
`DETACHED` thread, an annotation whose mark is gone); the anchored subset is `createPortal`ed
into the rail so one component still owns sort order, the `hashchange` effect and the tree
rendering. Below the breakpoint every surface is the single stacked list it always was, and
so is a page whose JS never runs: the `.anchored` class is toggled from JS, never from a
`@media` block. **CSS owns the two-column grid, JS owns only the vertical alignment** — so
don't move the column layout into JS to "simplify", that split is what keeps the rail
server-rendered in the right place. The two sides resolve an anchor differently and can't
share that step: a post comment reads its stored `anchorFrom` against an immutable
snapshot, while **a doc annotation has to be resolved against the live document, whichever
of its two mechanisms anchored it** — `resolveAnnotationRanges`
(`src/lib/annotation-marks.ts`) is the one function that answers for both, and every rail
and jump target goes through it rather than knowing there are two.
**Which mechanism follows the surface, never the permission** (PLAN.md §13o): the doc
*editor* writes an `annotation` mark into the doc's ydoc (§12i) and leaves
`anchorFrom`/`anchorTo`/`quotedText` null; either *reading* view writes those three columns
and never touches the document, so a reader annotating a doc no longer causes a write to
one they may not edit. Don't "unify" them by giving the reading views the mark back —
that write is the thing being removed, not an implementation detail. A row has one or the
other and never both; a null `anchorFrom` *is* "look for a mark instead".
`Annotation.ydocUpdateId` is no longer metadata-only: it's the version stamp those offsets
were measured against, and `quotedText` is derived server-side against exactly that state —
so replaying to it reproduces the quote by construction. It still drives the scrubber jump
it always did. Since §13q it names **the version the annotator was looking at**, not the
log's tail at post time: the client captures a `Y.snapshot` in the same synchronous tick it
reads the selection offsets (later is wrong — the freeze withholds the *render* while the
Y.Doc keeps advancing), and `resolveUpdateIdForSnapshot` converts it. A bare state vector
can't do this — deletions advance no clock, so ~10% of updates are invisible to one — and
`Y.encodeStateVectorFromUpdate` is the wrong primitive for reading a *delta*'s clocks, which
it answers with silence rather than an error. What keeps the conversion cheap is
`Ydoc.lastUpdateId`, written by the store debounce beside the blob and state vector it
already wrote: a rolling checkpoint the walk starts from. `scripts/integrity/check-annotation-anchors.ts`
is what verifies the whole arrangement still holds. Never position a doc annotation off `Doc.proseJson` — it's a store-debounce
snapshot, stale by seconds while anyone is typing; it's fine as the *seed* for which cards
start in the rail, and nothing more.
**A reply's anchor points into its parent annotation's body, not the doc** (§13p) — same
three columns, different target ydoc, and therefore a different update log stamping them
(`ydoc:annotation:<parentId>`). `postAnnotation` picks the target from
`parentAnnotationId` rather than taking it as an argument, so there's no request that
anchors a reply into the doc or a root into an annotation; an *anchorless* annotation still
stamps the doc's log. Selecting text in a posted annotation is the gesture that opens (or
re-points) that reply, which is why `AnnotationNode` renders bodies through
`AnnotationBodyReader` — a read-only TipTap editor behind the SSR copy — rather than the
static React tree alone: a browser `Selection` over static markup can't give ProseMirror
positions, and static markup can't carry the highlight decorations either.
How a remark stays attached to a passage while the passage moves — every strategy this
codebase uses, the ones it doesn't, and how to pick: [docs/COLLAB.md](docs/COLLAB.md). Read it
before adding another or "fixing" an anchor that looks fragile; several of the fragile-looking
ones are deliberate, and one plausible fix has already been tried and reverted as too brittle.
Authentication — session strategy, what the JWT bakes in, why sign-in is client-side:
[src/app/sign-in/NOTES.md](src/app/sign-in/NOTES.md).
Email delivery, rate limiting, and invites — why Resend, the `sendMail()` seam's contract,
`user_invite`'s many-rows-per-user design, and what's deferred (verification, bulk
invites): [docs/EMAIL.md](docs/EMAIL.md).
Who may do what, as tables over roles × doc visibility × byline membership, plus where each
rule lives so it can be re-derived: [docs/PERMISSIONS.md](docs/PERMISSIONS.md). A `PRIVATE`
doc is its listed `DocAuthor`s' alone — no ADMIN/EDITOR bypass (PLAN.md §12e).

## Running

- `npm run dev:all` — web (Next.js, :3000) + collab (Hocuspocus, :1234) via concurrently;
  one Ctrl+C stops both. Individually: `npm run dev`, `npm run collab`.
- `npm run stop:all` — stops a `dev:all` you (Claude) started, in one command instead of a
  netstat/parent-trace/taskkill dance across several. Verifies the port owner's command line
  actually mentions this repo before touching anything (see `scripts/stop-dev.ps1`).
- `.claude/launch.json` defines `web`, `collab`, and `web-prod` for the preview tool.
  `web-prod` runs `next start` on :3001 (so it can coexist with a `dev:all` on :3000) against
  whatever `npm run build` last produced — use it for anything caching-related, since
  `next dev` doesn't enforce the static/dynamic split or the Full Route Cache. It shells
  through `pwsh` to set `AUTH_TRUST_HOST`/`AUTH_URL`, without which NextAuth rejects
  `localhost:3001` as an `UntrustedHost` under `next start`. See CACHING.md's
  2026-07-24 entry.
- The user often runs `dev:all` themselves. **You may stop it** when the work needs it —
  `npm run stop:all`, then restart via the preview tool. Standing permission, no need to
  ask each time. Prefer attaching to what's already running (open the browser pane on
  http://localhost:3000) when that would answer the question, since a restart costs a cold
  recompile and can poison `.next` (see the Checks section); but a schema change or a new
  Prisma model *requires* the restart, and asking is worse than doing it. Say that you did.

## Database

- Local **Postgres 18** (Windows service `postgresql-x64-18`), owning port 5432. The
  `multiblog` role/DB connect passwordless — the 18 instance trusts all local connections.
  `psql -U multiblog -h 127.0.0.1 -d multiblog` just works. The old `postgresql-x64-14`
  service is stopped, not uninstalled: its data directory still holds the pre-rebuild
  database, recoverable with `pg_dump` by starting 14 on a spare port. That door closes if
  14 is ever uninstalled.
- **What Postgres 18 does *not* change, having been checked directly.** Worth recording
  because each looks like it should help and doesn't:
  - `jsonb_path_query(doc, '$.**.text')` **still double-counts** on 18.4, exactly as
    `add_doc_length_function`'s header found on 14 (a lone `{"type":"text","text":"hello"}`
    inside an array still yields `["hello","hello"]`). `doc_length`'s recursive CTE is not
    a workaround waiting to be retired. `JSON_TABLE` (new in 17) doesn't help either — it
    needs a known shape, and a TipTap document nests arbitrarily.
  - **Virtual generated columns** (18's headline, and now the default) reject
    user-defined functions outright: *"Virtual generated columns that make use of
    user-defined functions are not yet supported."* So `doc_length(prose_json)` cannot
    become one. A `STORED` column *is* accepted, and Prisma reads and sorts it correctly
    — but `migrate diff` reads the generation expression as a column default and
    permanently emits `ALTER COLUMN … DROP DEFAULT`, so every `migrate dev` would offer
    to strip the generated-ness. Hence `Doc.proseJsonLength` being a plain column plus a
    trigger (`doc_sync_prose_json_length`) instead: Migrate doesn't introspect triggers,
    so the trigger is invisible to it and the diff stays clean. **Never assign to that
    column** — the trigger owns it, on `INSERT` and on any `UPDATE` naming `prose_json`.
    A bypass (`DISABLE TRIGGER`, `COPY`, a restore) drifts silently; the `length-cache`
    check in `scripts/integrity/check-doc-integrity.ts` is what catches it, and a no-op
    `UPDATE doc SET prose_json = prose_json WHERE id = …` re-fires the trigger to repair.
  - **Self-join elimination** is on by default and does work (an inner join of a table to
    itself on the primary key collapses to one scan) — but it only fires for `INNER` joins,
    and Prisma emits a `LEFT JOIN` for a to-one relation ordering no matter how the
    relation is declared. So it does not rescue a view that reads its own base table. See
    `add_post_metrics_view` and PLAN.md §16l.
  - **B-tree skip scan** changes nothing here: every composite index this schema relies on
    (`post_publication_event(post_id, created_at)`, `post_author`/`doc_author`'s composite
    primary keys) is already queried on its leading column.
- Restarting the Postgres service needs an elevated shell — ask the user to do it.
- `npx prisma generate` fails with EPERM while the dev server runs (query-engine DLL is
  locked). Stop `dev:all`, generate, restart.
- **Adding a new model needs the dev server restarted, not just regenerated** — and the
  failure doesn't look like a stale client. `next dev` holds the generated `PrismaClient` in
  module memory, so after `prisma migrate dev` adds a model, the *running* server still has
  the client from before it existed: `prisma.yourNewModel` is `undefined`, and the first
  query dies with `TypeError: Cannot read properties of undefined (reading 'findMany')`
  pointing at your own query line. Typecheck passes (the regenerated types on disk are
  correct), which makes it read like a logic bug in the code you just wrote. Restarting web
  is the whole fix. Distinct from the EPERM case above: that one is generate refusing to
  *write*, this one is a successful write the running process never picks up.
- Generated Prisma client lives at `src/generated/prisma` (gitignored). Import from
  `@/generated/prisma/client` and `@/generated/prisma/enums`.
- One-off DB scripts (seeding/inspecting data outside the app) can't `require()` the
  generated client with plain `node -e` — it's TS source, not compiled JS. Write a `.ts`
  file importing `prisma` from `./src/lib/prisma` (same as `server/collab.ts` does) and run
  it with `npx tsx that-file.ts` from the project root; delete the file afterward.
- Dev account `labreuer@gmail.com` has role ADMIN.
- `.env` (never committed): `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `COLLAB_PORT`. Optional:
  `NEXT_PUBLIC_COLLAB_URL` — leave unset for local dev; `src/lib/collab-url.ts`'s `getCollabUrl()`
  (the one function every client-side `HocuspocusProvider` call goes through) derives
  `ws://<the page's own host>:1234` per request instead, so the same running dev server
  works from `localhost` *and* a LAN IP (e.g. testing from a phone) with no restart. Set it
  explicitly only for a real deployment (a different host/subdomain, or `wss://`) — once set,
  it pins every client to that one value, same as before. `next.config.ts`'s
  `allowedDevOrigins` is the separate, unrelated setting for letting a non-localhost origin
  reach the Next dev server itself (HMR, RSC) at all — needed for the same phone-on-LAN case,
  but for the web server rather than the collab one, and it does need a **restart** (not
  `getCollabUrl()`'s zero-restart) since it's read at `next dev` startup. `COLLAB_PORT` is bare,
  not `NEXT_PUBLIC_`, so it isn't readable client-side at all — `getCollabUrl()`'s `:1234`
  fallback is a literal, same as the `process.env.NEXT_PUBLIC_COLLAB_URL` reads it replaced.
  **`NEXT_PUBLIC_COLLAB_URL` is the browser's answer only.** The Next *server* also calls the
  collab process directly over plain HTTP (`/admin/ydoc-snapshot`, `/admin/annotation-mark`,
  `/admin/annotation-unmark`, `/admin/annotation-flush`); that origin comes from
  `src/lib/collab-http-origin.ts` — `COLLAB_INTERNAL_URL` (optional, bare) falling back to
  `http://127.0.0.1:${COLLAB_PORT}` — and must **never** be derived from
  `NEXT_PUBLIC_COLLAB_URL`. It was, and the bug was invisible locally and total in production:
  the public URL is `wss://<host>/collab`, nginx forwards `/collab/...` unrewritten, the
  handler matches on `/admin/...`, and Hocuspocus answers an unmatched path with a
  **`200 "Welcome to Hocuspocus!"`** — so all four endpoints silently no-opped while the
  websocket worked fine. Symptom was "Annotation can't be empty." on every annotation. PLAN.md
  §13m has the full account; the generalizable half is that a `NEXT_PUBLIC_` var answers "how
  does the *browser* reach this", which is the wrong question for a server-to-server call and
  happens to give the same answer as the right one only until a reverse proxy exists.
  Optional: `FILE_STORAGE_DIR` (default `.file-storage/`) and `FILE_MAX_UPLOAD_BYTES`
  (default 50MB) — both bare, so a deployment changes its upload limit with a **restart, not
  a rebuild**. That is why the browser learns the limit from `/api/files/limits` rather than
  from a baked-in constant: the client-side pre-check and the server's enforcement are then
  provably the same number.
  Optional: `NEXT_PUBLIC_SITE_TITLE` (defaults to `"MultiBlog"`,
  `src/lib/site-config.ts`) — deliberately env-sourced rather than hardcoded so a real
  deployment's title survives `git pull` instead of living in a tracked file. Also optional:
  `SITE_BANNER`/`SITE_BANNER_ASPECT`/`SITE_BANNER_ALT` (`src/lib/site-banner.ts`, PLAN.md
  §17b) — the landing page's banner image, path plus aspect ratio plus alt text. Bare, not
  `NEXT_PUBLIC_`, on purpose: unlike `NEXT_PUBLIC_SITE_TITLE`, these are read server-side
  only, so changing them needs a **restart, not a rebuild** — and the image file itself
  (`public/banner.*`, gitignored) needs neither, since `public/` is served straight from
  disk at runtime. Also optional: `RESEND_API_KEY`/`MAIL_FROM` (`src/lib/mail.ts`,
  [docs/EMAIL.md](docs/EMAIL.md)) — bare, not `NEXT_PUBLIC_`, so also a restart not a
  rebuild; unset keeps every environment on the logging stub. Any recipient on
  `@example.com`/`@sample.invalid` is never delivered to in any environment regardless of
  whether a key is set, so `npm run e2e` stays safe with a live key in `.env`. Also optional:
  `RESEND_INVITE_TEMPLATE_ID` — a Resend Template id for the invite email specifically
  (`sendUserInvite`, `src/app/actions/users.ts`); unset falls back to a plain text/subject
  send rather than failing, so invites work with no template ever created in the dashboard.
- **A contributor's avatar is bytes in `user_avatar`, not a URL** (PLAN.md §17n), served from
  `/api/avatar/<userId>/<hash>` where `hash` is a content hash — so the URL changes whenever
  the image does, which is what lets the route answer `Cache-Control: immutable` and use the
  same hash as its `ETag`. Three things not to undo:
  - **It's a separate table on purpose.** `src/app/users/page.tsx` queries with `include:` and
    no `select:`, so every scalar column comes back; an avatar column on `user` would drag up
    to 100 blobs into that page's payload silently. Any query that wants an avatar names
    `avatar: { select: { hash: true } }` — never `bytes`, which only the route handler reads.
  - **`User.image` stays a URL string.** It's the Auth.js adapter's field (`PrismaAdapter`),
    populated from an OAuth profile; `resolveAvatarSrc` (`src/lib/avatar-url.ts`) prefers the
    upload and falls back to it, then to the initials circle.
  - **`src/lib/avatar.ts` is server-only** (`sharp`, `node:crypto`). `avatar-url.ts` holds the
    browser-safe half, because `ContributorCard` builds these URLs and is imported by the
    `"use client"` `ContributorPanel`, so it compiles into the client bundle too.
  Uploads are always re-encoded (160px square WebP) rather than stored as sent — that's what
  strips EXIF/GPS from a phone photo, and `.rotate()` bakes the orientation flag into the
  pixels first so the strip doesn't leave it sideways. **The user picks the crop, in the
  browser** (`AvatarCropper.tsx`, PLAN.md §17o), so what's POSTed is a fixed ~320px square of
  tens of KB whatever the source was — which is why there is no byte cap anywhere and why
  Next's 1MB `bodySizeLimit` and nginx's 1MB `client_max_body_size` can stay at their
  defaults. Don't add one back: the guard that actually bounds ingestion cost is
  `MAX_INPUT_PIXELS` (50MP), since bytes predict decode cost badly. There is deliberately **no
  "avatar from URL" path**: a server-side fetch of a user-supplied URL is SSRF. `sharp` is a
  direct dependency pinned at the range its pre-existing `overrides` entry uses — npm rejects
  a direct dep whose spec doesn't match its own override.
- **An uploaded PDF is bytes on disk, not a `bytea`** (PLAN.md §19) — content-addressed at
  `FILE_STORAGE_DIR/<sha256[0:2]>/<sha256>`, served from `/api/files/<id>/<hash>` with `Range`
  support so PDF.js can render page 1 of a large scan without transferring all of it. Prisma
  cannot stream a `Bytes` column, which is the whole argument: a 50MB file would land in
  Node's heap on upload *and* on every one of pdfjs's range requests. `UserAvatar`'s
  in-Postgres bytes are not a counter-precedent — those are ~10KB and served whole.
  Consequences worth remembering:
  - **`FILE_STORAGE_DIR` is a second backup surface `pg_dump` does not cover** (DEPLOY.md).
  - **Never delete a file's bytes without counting references first.** Content addressing
    means two `StoredFile` rows can legitimately share one blob; `deleteBytesIfUnreferenced`
    takes the surviving count as an argument for exactly that reason.
  - The Prisma model is **`StoredFile`**, `@@map("file")`. The table is `file`; the generated
    TS type must not be `File`, which is a DOM/Node global the upload path uses.
  - **A file's listed users are `FileOwner`s, not authors** (PLAN.md §19): nobody on that
    list wrote the PDF. The list is seeded with the uploader, editable afterwards, and grants
    `/files`' Owner(s) line, the right to rename/re-slug/re-own/delete, and read access to a
    `PRIVATE` file. `DocAuthor`/`PostAuthor` are "author" because a doc's or post's listed
    users really did write it, and the shared filter kit (`AuthorFilterPanel`,
    `authorFilterWhere`, `AuthorMode`) is named for those two surfaces; `/files` reaches it
    through the `ownerFilterWhere`/`listOwnerFilterOptions` wrappers and an aliased import,
    and every option it added defaults to what `/docs` and `/posts` pass, which is what keeps
    those two tables out of it. Don't "unify" the two vocabularies in either direction.
  - Upload is a **Route Handler taking a raw body**, not a Server Action and not multipart:
    actions carry a 1MB `bodySizeLimit` that raising would raise site-wide, and
    `request.formData()` buffers the whole upload before user code sees it. nginx needs
    `client_max_body_size` raised to match (`deploy/nginx-app.conf.sample`); the uploader
    names the proxy explicitly on a 413 or a severed connection, since neither mentions nginx.
- **pdfjs traps, all four verified against 6.2.108** (PLAN.md §19, docs/PDF.md §10). Each
  fails in a way that does not look like its cause:
  - **Turbopack rewrites `require.resolve("pdfjs-dist/…")` to a virtual module id**, even
    under `serverExternalPackages`. pdfjs then reports `Invalid factory url: … must include
    trailing slash`, which reads like a malformed URL of ours. `src/lib/pdf-extract.ts`
    anchors `createRequire` at the project root *and* builds the specifier from a variable so
    it isn't statically analysable. This failed **only through Next** — the same code under
    `npx tsx` was fine.
  - **`workerSrc`, never `workerPort`.** A supplied port is shared, so destroying one loading
    task marks that PDFWorker destroyed and the *second* mount dies with `PDFWorker.create -
    the worker is being destroyed` — which reads like a missing `await` in our teardown.
    React StrictMode trips it on every dev page load.
  - **`workerSrc` wants a `file://` URL; `standardFontDataUrl` wants a bare path.** Same
    library, opposite spellings, because one goes through Node's ESM loader and the other
    through pdfjs's own filesystem read.
  - **`PDFDocumentProxy.destroy()` is gone in 6.x** (it has `cleanup()`, which leaves the
    worker alive) — destroy the *loading task*. And **`convertToViewportRectangle` no longer
    exists** despite docs/PDF.md §5 naming it; convert both corners as points instead.
  - **pdfjs has FOUR runtime asset directories, not two**, all fetched by URLs it builds by
    concatenation, so no bundler can see them: `standard_fonts/`, `cmaps/`, **`wasm/`** (the
    JBIG2 and JPEG 2000 decoders) and `iccs/`. `scripts/copy-pdfjs-assets.ts` copies all four
    into `public/` and is wired as `prebuild`/`predev`, making it unskippable; the copies are
    gitignored, and `public/pdfjs/**` is eslint-ignored because the wasm fallbacks are
    minified JS. Miss `wasm/` and a **scanned** PDF renders as blank pages with a working text
    layer floating over them — which reads as "the viewer is broken", not as a decoder
    problem. An unset URL concatenates onto `null`, so the tell is
    `Failed to resolve module specifier 'nullopenjpeg_nowasm_fallback.js'`.
    **The e2e fixtures cannot catch this**: `scripts/make-test-pdf.ts` generates text-only
    PDFs, which exercise no image decoder at all. `e2e/pdf-assets.spec.ts` asserts each
    directory is served instead — that is the only guard, so don't delete it as trivial.
- **`globals.css`'s `* { box-sizing: border-box }` breaks pdfjs, and the symptom is a
  *scale* error rather than a layout one.** pdfjs's stylesheet is written for content-box: it
  sets `.page`'s width/height to the scaled page size and adds a 9px `--page-border` outside
  it. Under border-box the border eats into that size instead, so the rendered content is
  ~18px narrower than the viewport transform believes — about 2%, growing with the length of
  whatever is being measured. `PdfViewer.module.css` restores `content-box` for `.pdfViewer`
  and its descendants; don't "tidy" that away. Related and separate: a page's
  `getBoundingClientRect()` is the **border** box, while every layer we draw into is
  `inset: 0` and therefore positions from the **padding** box, so capture has to add the
  border widths back (`pageContentOrigin`, `pdf-anchor-capture.ts`). docs/PDF.md §5's "the
  page element's top-left" is imprecise on exactly this point.
  Both bugs shipped together and **every test passed**: the overlap assertion tolerated a
  4.5px error. `e2e/pdf-annotations.spec.ts` now asserts *alignment* to within 2px at three
  zooms, because the two failed differently — the border offset was constant in CSS pixels,
  the box-sizing error scaled.
- **A PDF anchor cannot drift, and that is why its code is so much smaller than a doc's.** A
  file's `sha256` is its identity, so the bytes an anchor was measured against are by
  construction the bytes every later reader sees. There is no tracking plugin, no
  per-transaction re-resolution and no version stamp — `Annotation.ydocUpdateId` is
  meaningless for a file. `docs/PDF.md` §4's quote/position steps exist only to survive
  changes to **our own** normaliser (`src/lib/pdf-text.ts`, whose `NORMALISER_VERSION` must be
  bumped on *any* behavioural change, however small). `quotedText` is still derived
  server-side from `FilePageText` — the page text extracted once at upload — so §12i's "the
  selected text is a request field only, never a column" survives; `scripts/integrity/check-pdf-anchors.ts`
  is what verifies that claim, and it is the only thing that would ever notice it breaking.
- Site icons (favicon/manifest): [docs/FAVICON.md](docs/FAVICON.md).
- The landing page's preamble (`/`, PLAN.md §17c) is the body of whichever `Doc` is titled
  exactly `FRONT PAGE` (case-insensitive, first-created wins if more than one exists) — its
  own title is never shown, only its body. Seed one with `npx tsx scripts/seed-front-page.ts`
  (create-if-absent, never clears anything). No `DocVisibility` check: a doc's `visibility`
  still gates `/doc/<slug>` exactly as before, but the title alone is what makes its body
  public here — see PLAN.md §17c for why gating on `SHARED` would be wrong.
- Adding a **required** (non-nullable, no `@default`) column to a table that already has
  rows: `prisma migrate dev` normally prompts interactively for how to backfill existing
  rows, which doesn't work non-interactively. Instead, add the field nullable first and
  migrate, backfill via `psql`/a script, then drop the `?` and migrate again — the second
  migration is a plain `ALTER COLUMN ... SET NOT NULL` with no prompt, since every row
  already has a value by then. See `adminInitials`'s two migrations
  (`add_admin_initials_nullable`, `make_admin_initials_required`) for the pattern.
- **Editing a migration file after it's been applied makes the next `migrate dev` demand a
  full database reset** — and the message says so in a way that's easy to accept by reflex:
  *"The migration `…` was modified after it was applied. We need to reset the `public`
  schema … All data will be lost."* Prisma records a SHA-256 of each `migration.sql` in
  `_prisma_migrations.checksum`, and any edit — including appending a hand-written backfill
  to a file `migrate dev` just generated — invalidates it. **Do not reset a dev database
  holding real content.** When the database genuinely already reflects the edited file (the
  DDL ran, and the backfill was applied by hand), the schema and the file agree and only the
  recorded checksum is stale, so correct that instead:
  ```
  sha256sum prisma/migrations/<name>/migration.sql
  psql -U multiblog -h 127.0.0.1 -d multiblog \
    -c "UPDATE _prisma_migrations SET checksum='<hash>' WHERE migration_name='<name>';"
  ```
  Take a `pg_dump` first (`.db-backups/`, the convention that directory exists for). Note the
  `pg_dump` on `PATH` is the **14.2** one from the stopped `postgresql-x64-14` install and
  refuses an 18.4 server (`server version mismatch`) — use
  `"/c/Program Files/PostgreSQL/18/bin/pg_dump.exe"`. Better still, put the backfill in the
  file *before* the first `migrate dev` run, or in its own follow-up migration.

## Checks & verification

### Automated

- Typecheck `npx tsc --noEmit`; lint `npx eslint .`.
- **ESLint stays on 9 and TypeScript on 5 — both are gated on `eslint-config-next`,
  not on us.** `npm outdated` offers eslint 10 and typescript 7; neither works yet.
  eslint 10 removed `context.getFilename()`, which `eslint-plugin-react` still calls, so
  `npx eslint .` dies with `contextOrFilename.getFilename is not a function` before
  linting anything ([eslint-plugin-react#4018](https://github.com/jsx-eslint/eslint-plugin-react/issues/4018),
  a dup of #3977). `eslint-plugin-import`/`-react`/`-jsx-a11y` all cap their `eslint`
  peer at `^9` and are pulled in by `eslint-config-next`, so this is not overridable.
  typescript 7 is blocked separately by `typescript-eslint`'s `<6.1.0` peer. Both
  unblock when Next ships a refreshed lint config — recheck then, not before.
  Taking eslint 10 *would* drop the `brace-expansion` audit count from 9 to 6.
- `npm run e2e` — Playwright end-to-end suite (~20s), covering publish/unpublish,
  comment moderation, and two-author live collab. **Prefer it to driving the browser
  pane by hand** for anything it already covers, and for anything worth covering: one
  command replaces a dozen `read_page`/click round trips, and a spec can do the setup
  *and* the `boundingBox()`/`getComputedStyle` measurement in one process. Fixtures
  create and delete their own throwaway users/posts, and it reuses a `dev:all` you
  already have running rather than starting (or killing) its own. Full details,
  fixtures, and the gotchas that bite when writing new specs: [e2e/README.md](e2e/README.md).
- **A killed `next dev` can poison `.next/dev` so the *next* start hangs mid-compile.**
  Symptom: the server logs `✓ Ready`, serves `/` fine, then prints
  `○ Compiling /api/auth/[...nextauth] ...` and never finishes — so `/sign-in` hangs
  indefinitely and every spec dies in `auth.setup.ts` with `page.goto: net::ERR_ABORTED`
  or a 60s timeout. It reads exactly like an auth regression and isn't one; the same
  commit passes a full run once `.next` is gone. `rm -rf .next` is the whole fix
  (`Remove-Item -Recurse -Force .next`). Playwright kills the dev server it started at
  the end of a run, so this is most likely on the run *after* a suite that started its
  own — i.e. when you're bisecting a dependency bump and least want a phantom failure.
  Check `.next/dev/logs/next-development.log` for a `Compiling …` line with no matching
  completion before blaming your changes.

### Driving the browser pane

Everything in this subsection is **browser-pane behavior specifically**. None of it
applies under Playwright — which is half the reason to prefer `npm run e2e` for
anything repeatable.

- Verify changes live in the pane before reporting them done — for behavior the suite
  doesn't cover, or when you need to *look* at something rather than assert on it.
- The `computer` screenshot action reliably times out in this environment — verify with
  `read_page` / `javascript_tool` measurements (bounding rects, computed styles) instead.
  Coordinate-based clicks are collateral damage: `computer` refuses `left_click` with a
  `coordinate` until a screenshot has cached the viewport dimensions, so coordinates are
  never an available fallback here. If you genuinely need an image, `page.screenshot()`
  in a throwaway spec produces one.
- `computer`'s `ref`-based clicks can silently no-op on the editor's action buttons — the
  call reports success and nothing happens (seen repeatedly on Publish in the old
  `PostEditor`, before `PostPublisher` replaced it, PLAN.md §15c). When a click appears to
  do nothing, drive it from `javascript_tool` instead:
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Publish').click()`
  dispatches a real React-visible click and works every time. Confirm the result via
  `get_page_text` rather than assuming.
- To set the editor's content in one shot (rather than the per-character benchmark loop
  below), focus `.tiptap`, select its contents with a `Range`, then
  `document.execCommand('insertText', false, "…")` — collapsing the range first appends,
  leaving it selected replaces. Wrap it in an IIFE: `javascript_tool` reuses one scope
  across calls, so a bare `const t = …` fails with "already declared" on the second call.
- The browser pane's console buffer accumulates across navigations; for a clean error
  check, open a fresh tab.
- Sessions use NextAuth's `jwt` strategy (`src/lib/auth.ts`): `id`/`role`/`color` are baked
  into the session cookie once at sign-in and never re-read from the DB on later requests.
  Deleting a throwaway `User` row mid-session does **not** sign them out or revoke their
  role — the browser tab keeps showing (and acting as) that stale identity until an explicit
  sign-out or the JWT expires. Don't take "the user row is gone" as proof a test session has
  ended; click Sign out (or open a fresh tab) before relying on the signed-out UI state.
- The browser pane's tabs share one cookie jar. If you sign in as a second user in tab B,
  tab A silently becomes that second user too the next time it does a fresh navigation —
  an already-loaded tab's live WS connection/React state keeps its original identity only
  until you reload or navigate it. Do each test user's sign-in in its own tab, and only
  reload a tab when you actually mean to switch who it's authenticated as. This is why
  anything concurrent (two authors editing one post) belongs in a spec instead: Playwright
  gives each identity its own `browser.newContext()`, with its own jar — see the
  `secondUser()` fixture and `e2e/collab.spec.ts`.

### Throwaway test data

- `scripts/test-user.ts` (create/delete accounts of any role, optionally with a
  `Commenter` row for trust/moderation states), `scripts/test-doc.ts` (create/delete docs,
  optionally seeded with body text), `scripts/test-post.ts` (create/delete posts against a
  `--doc <id>`, draft or published, with a moderation policy — PLAN.md §15: a post is
  always a snapshot of some doc, never independently authored), `scripts/test-comment.ts`
  (list a post's comments and their statuses), `scripts/test-file.ts` (create/list/delete
  uploaded PDFs — it *generates* its own document via `scripts/make-test-pdf.ts` and pushes it
  through the real storage and extraction path, so a fixture file is indistinguishable from an
  uploaded one), `scripts/test-ydoc.ts` (create/list/delete
  standalone documents in the ydoc stack, PLAN.md §11 — `--garbage` writes bytes that
  aren't a valid Yjs update at all, to exercise `/ydoc-debug`'s "not TipTap-compatible"
  error path on purpose). Each script's header comment documents its own flags — read that
  rather than a copy here, which is what will go stale. Defaults worth knowing without
  opening anything:
  `test-admin@example.com`, role `ADMIN`, password always `testpass123`.
- `test-user.ts`/`test-doc.ts`/`test-post.ts`/`test-comment.ts`/`test-file.ts` all refuse to touch
  anything but `@example.com` accounts and docs/posts authored solely by them, so they
  can't reach real data by mistake. Delete a post or doc *before* its author: once its
  only author is gone, "no authors" is indistinguishable from a real one that lost its
  author some other way, so `delete` refuses it. Delete a post *before* its doc too —
  `Post.docId` has no `ON DELETE CASCADE` (PLAN.md §15), so a doc with a post still
  pointing at it can't be removed underneath it. `test-ydoc.ts` uses the equivalent
  containment for a table with no email column: it only ever creates ids under the
  `ydoc:test-` prefix (`src/lib/ydoc-names.ts`) and refuses to `delete` anything else.
- `scripts/seed-sample-data.ts` is the odd one out, and deliberately inverts the convention
  above. It seeds *durable* sample content for a freshly rebuilt database — four docs, four
  posts spanning draft/scheduled/published, six comments across every status (one thread
  quote-anchored), and four annotations, one left document-level on purpose so
  `/annotations` has a row exercising that state. Its addresses are `@sample.invalid`
  (RFC 2606, guaranteed unroutable) rather than `@example.com`, and its titles carry no
  `E2E ` prefix, precisely so the e2e teardown *doesn't* sweep it back out.
  - Re-running is idempotent rather than additive: it clears its own content first, and
    `--reset` does only that clearing step. Both paths empty the content tables wholesale,
    so both refuse unless the doc count is 0 (fresh database) or exactly
    `SAMPLE_DOCS.length` (its own output) — `--force` is the deliberate override, and the
    check counts soft-deleted docs too, since a doc in the trash is still content the clear
    would destroy.
  - **User rows are the exception no flag widens**: only the three `@sample.invalid`
    addresses are ever deleted, so an account someone actually signed up with survives both
    paths. Sample accounts use the same `testpass123` as the throwaway scripts.
  - The collab server has to be running, or the anchored annotations quietly degrade to
    document-level — `applyAnnotationMark` reaches the doc's live ydoc through it (§12i).
    A doc's title is seeded into its own Yjs fragment as well as the column, because the
    fragment is canonical (§3d) and `server/doc-cache.ts` otherwise writes an empty title
    straight over the column on first flush.
- The e2e suite needs none of this — its fixtures create and clean up their own rows
  (`e2e/db-worker.ts`, same `@example.com` guard, plus the `ydoc:test-` prefix guard for
  `e2e/ydoc-debug.spec.ts`), and a teardown project sweeps whatever a crashed run left
  behind.

### One-shot data imports

Two, both carrying their rationale in a long file header rather than here — read the header
before touching either, and prefer copying their shape to inventing a third one:

- `scripts/import-legacy.ts` — a pre-§15 MultiBlog database into the present schema.
- `scripts/etherpad/import-etherpad.ts` — an Etherpad Lite `dirty.db`, preserving full
  per-revision edit history: each pad becomes a Doc plus one `ydoc_update` row per
  Etherpad revision, timestamped and attributed. `--verify` replays the whole file and
  checks it against the atext Etherpad itself stored at every 100th revision and at
  head, without touching the database; `--list-authors` prints the `--authors` mapping
  skeleton; `--dry-run` does the real import and rolls it back. Run all three, in that
  order, before a live run. Full rationale: `scripts/etherpad/README.md`.

Both share the conventions worth knowing: an existing user is matched by email and never
duplicated, slugs are claimed through the transaction (`claimSlug` — `uniqueDocSlug`/
`uniqueUserSlug` query the global client and can't see rows the same import just created),
the `ydoc` blob is always recomputed as `Y.mergeUpdates` over the rows being written rather
than copied from a source, and `@updatedAt` columns need raw SQL to backdate. Afterwards,
`scripts/integrity/` is the acceptance test — run all three of its checks, ydoc first (a bad
blob makes the doc- and annotation-side checks report faults that evaporate once it's
repaired). See [scripts/integrity/README.md](scripts/integrity/README.md) for which link of
the `ydoc_update → ydoc.ydoc → doc.*` chain each one covers, and why
`check-annotation-anchors` is the odd one out: it verifies a *claim written down once*
("at update N, characters [a, b) read exactly this") rather than a derived value, which is
why nothing recomputes it and why a break there is silent.

### Performance measurement

- For editing-latency benchmarks, `document.execCommand('insertText', false, char)` in a
  loop inside the editor's `.tiptap` element, timed with `performance.now()` per call, drives
  a real ProseMirror transaction through the normal path (mark-tagging, Yjs sync,
  decorations) without OS input-pipeline noise — reproducible enough for relative
  before/after comparisons. `execCommand('delete', false)` undoes it the same way,
  character-for-character, to restore test content afterward. The same loop runs inside
  `page.evaluate` in a spec, which is one command rather than a per-keystroke drive
  through the pane, and can print its numbers straight to stdout.
- For performance/stress testing at a realistic content size, copy the target content into
  a throwaway post rather than editing the real one directly — removes any risk from a
  botched restore step.
- To A/B a performance change against actual history rather than guessing: confirm
  `git status` is clean, `git checkout <old-commit>`, stop/restart `dev:all` (checkout
  doesn't hot-reload cleanly across many files — the collab server especially needs a real
  restart), measure, then `git checkout <branch-name>` and restart again. With uncommitted
  work, `git stash push -u` / `git stash pop` does the same job without needing a commit.

### Restarting the collab server

- **Restarting never duplicates a document's content.** `ydocOnLoadDocument`
  (`server/ydoc-hooks.ts`) creates its `ydoc` row *eagerly*, in `createIfAbsent`'s
  transaction, before any client's content is ever applied — there's no window where a
  killed server "never got around to" persisting a row, so a restart always finds one
  waiting and re-seeds from the actual same lineage rather than building a structurally
  new document. This used to be a contrast worth drawing against posts, which had their
  own lazily-created `PostCollab` row and a real doubling bug; posts have no editable
  content of their own any more (PLAN.md §15), so there's nothing left to contrast against.
- **A doc's `ydoc` row *is* the doc, with no fallback to re-seed from** — unlike the old
  post-editing days, there is no revision to fall back to, and an annotation's anchor is a
  mark embedded in that exact row's content (§12i), not a position computed against it.
  Deleting `ydoc`/`ydoc_update` for a doc's id and letting it re-seed doesn't recover
  anything — there's nothing to re-seed from, and `createIfAbsent` would just build an
  *empty* document under that id, discarding every paragraph and every annotation the doc
  ever had. If a doc's `ydoc` row is ever genuinely corrupted, the only way back is the
  update log itself (`ydoc_update`, never truncated), replayed via `/ydoc-debug` (a doc's
  `ydoc:<docId>` row is just another entry in the same table an ADMIN can select there) —
  not a delete-and-restart.

## Gotchas

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
  finished string in the RSC payload (`app/doc/[slug]/page.tsx` does this deliberately). Only a
  client component's copy renders on both sides. A call site whose data arrives from a
  client-side fetch is also fine, since it was never in the SSR HTML — that's why the scrub bars
  and most of `YdocDebug` were left alone. This class is **invisible to every local check**,
  including `npm run e2e` and `web-prod`: locally the dev server and the browser are one
  machine and so always agree. Same reason PLAN.md §13m's collab bug survived to production.
- `globals.css` has `* { margin: 0; padding: 0 }` — it strips default list/blockquote
  styling everywhere. `src/styles/prose.module.css` restores it for rendered post content;
  any new surface rendering post content needs its `.prose` class.
- **No hex/named color literal anywhere in `src/` outside `src/app/globals.css`,
  `src/lib/author-colors.ts` (the author palette + `NEUTRAL_THREAD_COLOR`), and the handful
  named in STYLE.md's Dark theme section.** Every color is one of `globals.css`'s tokens —
  `style={{ color: "var(--text-secondary)" }}` is valid CSS and is the convention for inline
  styles, not just CSS Modules. `light-dark()` only accepts `<color>` arguments, so a
  percentage or other number that needs to change with scheme (the anchor-highlight tints)
  goes through the `--dark: 0/1` flag and `calc()`, not `light-dark()` itself. Full rationale,
  the token list, and the grep guard: STYLE.md's Dark theme section.
- `body` gets implicit `overflow-y: auto` (side effect of its `overflow-x: hidden`), and
  `documentElement` is the effective scroller — use `window.scrollY`, not
  `body.scrollTop`, when checking scroll behavior.
- TipTap v3's StarterKit already bundles Link, Bold and Italic (among others) and
  undo/redo: never add any of those extensions **alongside StarterKit** in the same
  schema, and pass `undoRedo: false` when combining StarterKit with the Collaboration
  extension (`undoRedo` stays on wherever there's no `Collaboration` to own the history
  stack instead — `blurbExtensions` below is the one schema in this codebase where that
  inversion applies). `@tiptap/extension-document`/`-paragraph`/`-text` *are* declared
  deps, which isn't a violation of that: they're for schemas built **without** StarterKit
  at all, so nothing is double-registered — the **title** editor's `titleExtensions`
  (`CollabTitleField.tsx`) and the **contributor blurb**'s `blurbExtensions`
  (`ContributorPanel.tsx`, PLAN.md §17f), both constrained to `content: "paragraph"` so a
  second block is structurally impossible. `blurbExtensions` also declares
  `@tiptap/extension-bold`/`-italic` directly for the same reason — StarterKit has no
  option to keep only `document`/`text` and drop everything else, so building the schema
  from scratch is the only way to get "exactly one paragraph, a couple of marks, nothing
  else". Pin every one of these to the same exact version as `@tiptap/core` when
  installing — `^3.28.0` resolves to 3.29.0, whose peer dep is `@tiptap/core@3.29.0`
  exactly, and npm fails the install.
- **TipTap v3's `setContent` takes an options object where v2 took a boolean**:
  `editor.commands.setContent(json, { emitUpdate: false })`, not `setContent(json, false)`.
  The v2 form is a type error (`Type 'false' has no properties in common with type
  'SetContentOptions'`) but reads as obviously-correct against any pre-v3 example or answer,
  so it's worth recognizing rather than re-deriving. Used by `LiveDocBody.tsx` to push live
  Yjs updates into a non-`Collaboration` editor without re-emitting them.
- **TipTap v3's `Collaboration` extension binds through `@tiptap/y-tiptap`, not
  `y-prosemirror`** — a separate package (Tiptap's own fork,
  `node_modules/@tiptap/extension-collaboration/dist/index.js` imports every one of
  `ySyncPlugin`/`ySyncPluginKey`/`absolutePositionToRelativePosition`/
  `relativePositionToAbsolutePosition` from it). Reading a Collaboration-bound editor's
  sync-plugin state (`ySyncPluginKey.getState(editor.state)`, e.g. to reach the
  y-prosemirror binding's `ProsemirrorMapping` for a relative-position conversion) needs
  the key imported from `@tiptap/y-tiptap`, or `PluginKey.getState()`'s identity match
  silently fails: it doesn't throw, it just returns `undefined`, indistinguishable from
  "this editor has no Collaboration binding at all." `src/lib/yjs-relative-anchor.ts`
  shipped with the wrong import for one review cycle (PLAN.md §18f) — every selection on
  `/doc/[slug]/edit` silently failed to capture, caught only by manual testing, not by
  `npx tsc`, `eslint`, or the e2e suite (nothing exercises that page's *selecting* text,
  only typing into it). `y-prosemirror` itself stays a real dependency — `server/
  ydoc-hooks.ts` uses it correctly for stateless Yjs↔ProseMirror conversion server-side,
  which never touches a `PluginKey` — the trap is specifically about plugin-state lookups
  against a live client-side `Editor`.
- The TipTap schema is shared by the editor, Hocuspocus doc-seeding, and public rendering
  via `src/lib/tiptap-schema.ts` — change it only there so the three can't drift. It holds
  *two* schemas: `contentExtensions` (post body) and `titleExtensions` (the title, a separate
  Yjs fragment — see PLAN.md §3d). Each has mark-layered variants stacked on it rather than
  a parallel definition, and picking the wrong one silently drops marks on
  decode/render: body is `contentExtensions` → `authorHighlightExtensions` (working Yjs
  session) → `docContentExtensions` (that plus the annotation mark, doc side only, PLAN.md
  §12i); title is `titleExtensions` → `titleAuthorHighlightExtensions`. Anything decoding a
  *doc's* ydoc wants `docContentExtensions` — `server/doc-cache.ts` and
  `src/lib/ydoc-render.ts` both do.
- `CollaborationCaret` has no per-field awareness key: every instance writes
  `awareness.cursor`. Two of them on one provider (e.g. body + title editors sharing a
  `Y.Doc`) therefore render each other's positions against the wrong fragment. Only the body
  editor gets one; the title field syncs text without remote carets.
- The `Collaboration` extension's `onFirstRender` is **not** "the doc has synced": with the
  collab server unreachable it fires right away against the still-empty fragment, so anything
  that treats empty-means-empty (a title-changed comparison) sees "" as real content.
  `HocuspocusProvider`'s own `onSynced`/`onStatus` is the signal for that — see
  `use-live-doc-content.ts`'s `synced` (read-only taps) and `DocEditor.tsx`'s
  `connectionStatus` (the write side). `onFirstRender` also fires *during* `useEditor`'s
  render, so calling a parent `setState` from it trips React's "state update on a component
  that hasn't mounted yet"; report upward from an effect instead (`CollabTitleField.tsx`).
- `document.querySelector('.tiptap')` now matches the **title** editor first — the body editor
  is `querySelectorAll('.tiptap')[1]`. Relevant to the editing-latency benchmark and
  content-setting recipes above, which target `.tiptap`. Both editors also carry an
  `aria-label` (`Title` / `Post body`) on their contenteditable, which is what the e2e
  suite keys off instead of DOM order.
- ProseMirror drops custom attributes where inline decorations overlap; the quote-highlight
  extension pre-splits ranges into non-overlapping segments (`data-thread-ids`, plural).
- `authorHighlight` marks (per-author color-coding, `src/lib/author-highlight-extension.ts`)
  live in a doc's working Yjs state and nothing ever removes them from the doc itself — a
  doc has no save step to hook a reset into (PLAN.md §12k), unlike the old post editor's
  `clearAuthorHighlights`, which doesn't exist any more. They just accumulate in the doc
  forever. What keeps them out of *published* content is `postContentFromYdoc`
  (`src/lib/post-content.ts`), which strips `authorHighlight` (and `annotation`) from a
  snapshot before it's ever written to `Post.proseJson` (PLAN.md §15b) — the live doc a
  reader edits and the copy a post publishes are different JSON from that point on.
- `CollaborationCaret`'s default `render` shows an always-visible name label. We override it
  (`renderCaret` in `CollabEditorBody.tsx`) to draw just a colored bar, with the name in a
  CSS `:hover`-only tooltip (`.collabCaret`/`.collabCaretLabel` in `DocEditor.module.css`,
  shared by every `CollabEditorBody` consumer). The local user's own cursor was never
  affected either way — y-prosemirror's cursor plugin filters out the local clientID before
  `render` is ever called.
- A flex item's `flex-grow`/`flex-shrink` only has a budget to work with if its flex
  *container* has a definite (not `min-height`-only) main size — `min-height` lets the
  container's own size fall back to its content's, which defeats grow/shrink on children
  entirely. `body` (`globals.css`) sets `height: 100vh`/`100dvh` for exactly this reason: it's
  what lets `DocEditor.module.css`'s `.container` (and everything nested under it —
  `.editorFrame` → `.editorContent`) actually fill "the viewport minus the global
  `SiteHeader`" instead of silently reverting to content-based sizing and producing an
  always-present page scrollbar. `PostPublisher.module.css` has no equivalent budget to
  manage — nothing in it is a live editing surface any more (PLAN.md §15c).
- Sizing something as "half of the heading it sits next to" needs `em` (relative to the
  *immediate parent's* font-size), not `rem` (relative to the *root* font-size) — `rem` gives
  you "half of whatever the root/site-header text renders at," which is a different, usually
  smaller, number than the actual surrounding `h1`/`h2`. The now-deleted `PostEditBadge.tsx`'s
  `(edit)`/`(edited)` link learned this the hard way: `0.5rem` came out as a *quarter* of the
  `h1` on the single-post page (32px) and a *third* of the `h2` in listings (24px), both
  because it was computing against the root's 16px instead of either heading's own size —
  worth keeping in mind for anything sized the same way later, even though that specific
  component is gone (PLAN.md §15: a published post no longer surfaces a live-staleness
  signal at all, by decision — see §15h).
- When matching one element's width to another's via `ResizeObserver` (e.g. `PostsTable`'s
  search box tracking the Title column's width): use the observed element's own
  `getBoundingClientRect().width` inside the callback, not the callback's own
  `entries[0].contentRect.width` — `contentRect` is always the *content* box (padding and
  border excluded) regardless of the element's `box-sizing`, so on a padded `<th>` it under-
  reports by the padding, and copying that value straight into another element's CSS `width`
  (itself `box-sizing: border-box` from the global reset) makes it visibly narrower than the
  element it's supposed to match.
- **One document stack, one Hocuspocus process and port, two sub-namespaces within it**
  (PLAN.md §11/§15): every `documentName` is `ydoc:`-prefixed, handled by
  `server/ydoc-hooks.ts` against the `ydoc`/`ydoc_update`/`ydoc_snapshot` tables. There used
  to be a second, older stack for post documents (bare cuid names, `post_collab`/
  `post_collab_update`, a parallel set of hooks in `server/collab.ts`) — that's gone; posts
  are immutable snapshots now, with nothing of their own to edit (§15). `server/collab.ts`
  keeps only dispatch: `onAuthenticate` rejects any non-`ydoc:` name outright (the real
  chokepoint, since registering it is what makes Hocuspocus require auth on every
  connection at all), and the other hooks call straight into `ydoc-hooks.ts`.
  `isYdocDocument`/`YDOC_PREFIX` (`src/lib/ydoc-names.ts`) still exist, but their job
  changed: not routing away from a legacy path any more, just carving out the
  `ydoc:annotation:` sub-namespace and the `ydoc:test-` containment guard. A `ydoc:` name
  nobody has explicitly created via `scripts/test-ydoc.ts`, `scripts/test-doc.ts`, or
  `/ydoc-debug`'s "New document" button just starts empty.
- **`y-indexeddb`** (`src/lib/ydoc-persistence.ts`, PLAN.md §11e — also used by
  `DocEditor.tsx` and `DocColumn.tsx`'s write mode, §14l): never construct a second
  `IndexeddbPersistence` for a `Y.Doc` that already has one.
  [y-indexeddb#25](https://github.com/yjs/y-indexeddb/issues/25) — each instance re-persists
  updates the *other* instance already wrote, because the library's own guard only excludes
  itself as an origin, not sibling instances. `attachIndexeddb` is ref-counted per local
  IndexedDB database *name* (a `Map`, not a `WeakMap<Y.Doc>` — re-keyed in PLAN.md §14l
  Phase 0), so React StrictMode's double-invoked effects (same `Y.Doc`, attached twice)
  reuse the one instance, *and* a second attach for a genuinely different `Y.Doc` against
  the same name is refused outright rather than silently building a competing instance —
  the shape `/side-by-side/<a>/<a>` would hit if the route didn't already reject it (PLAN.md
  §14c). Separately, the local IndexedDB database is keyed by the document's *lineage*
  (`ydoc.created_at`, fetched from `/api/ydoc/[id]/token` alongside the collab token) rather
  than by `documentName` alone — `created_at` only changes if the row is ever recreated,
  i.e. exactly when the server has built a structurally new document, so a stale local copy
  can never merge into a re-seeded one. Attach the lineage-keyed store *before* connecting,
  never cache it to attach earlier — caching would let a stale copy merge in before the
  mismatch could be detected, which is the bug this avoids, not a race around it.
- **`/ydoc-debug`'s replay slider is deliberately unoptimized** (PLAN.md §11h) — no debounce, no
  cache of other positions, no precompute. Backward scrubbing across a long log *is* supposed to
  stutter: Yjs updates are append-only with no un-apply, so going back rebuilds from the nearest
  snapshot while going forward just advances the doc already in hand. Don't "fix" it. Two things
  to know before reading its numbers: (a) the `Y.encodeStateAsUpdate` behind the `(+N)` size
  delta runs on every scrub step and is pure instrumentation — it's outside the timer because
  it isn't part of the rebuild, but on a large document it can cost more than the rebuild the
  timer reports, so the ms figure is not the per-step cost of the view; (b) forward is *not*
  always incremental — jumping forward across a newer snapshot rebuilds from that snapshot,
  which is both correct and cheaper than replaying the deltas in between, and is the only way a
  snapshot earns its keep on a forward jump. The `forward`/`rebuild` marker at the head of the
  status line is what tells the two apart.
- **A Next dynamic-route `params` value arrives percent-encoded, not literal.** `getParamValue`
  in `next/dist/shared/lib/router/utils/get-dynamic-param.js` runs `encodeURIComponent` on every
  string param before handing it to user code — verified against `next@16.2.11`. A route that
  tried to pack two ids into one segment (`/side-by-side/[pair]`, meaning `a+b`) would see
  `params.pair === "a%2Bb"`, not `"a+b"`, so `.split("+")` would silently return one element and
  404 every URL — a `+`-means-space assumption that's true for query strings and false here
  (`getRouteMatcher` already `decodeURIComponent`s the captured group; the `%2B` comes from the
  *re*-encode after that). `/side-by-side/[left]/[right]` (PLAN.md §14c) uses two path segments
  specifically to never need to decode anything.
- **A doc link's anchor (PLAN.md §14) is a plain JSON blob in Postgres, not a mark in the doc's
  ydoc** — the opposite of an annotation's anchor (§13), and deliberately: a link joins two
  *different* docs, and no single ydoc can hold that. The cost is drift, paid for by re-running
  `findQuoteOccurrences` against the current document on every content change (§14d) — memoized
  per column, since the read surface does this on every remote keystroke, not just at load.
  Persisting a corrected offset only ever happens from a column in *write* mode: a read column's
  view is always at least one Yjs update behind, so a "correction" it computed was already stale,
  and persisting it would be N concurrent readers last-writer-wins on the one field whose entire
  job is precision.

## Conventions

- Commit only when the user explicitly asks. Commit messages explain *why*, not just what.
- Flag deviations from PLAN.md and judgment calls explicitly when reporting work.
