# MultiBlog — notes for Claude

Multi-author blog with revisions, real-time collab, and quote-anchored comments.
Architecture and build order: [PLAN.md](PLAN.md) — §10 tracks what's actually built vs. planned.
Performance findings and the opt-in perf-logging tool: [PERFORMANCE.md](PERFORMANCE.md).
Caching behavior/trade-offs (ISR, ...): [CACHING.md](CACHING.md).
Styling conventions (colors, typography, CSS Modules vs. inline): [STYLE.md](STYLE.md).

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
- The user often runs `dev:all` themselves. If port 3000 is held by a non-preview node
  process, don't kill it — open the browser pane directly on http://localhost:3000.

## Database

- Local Postgres 14 (Windows service `postgresql-x64-14`). Role/DB `multiblog` connects
  passwordless via trust entries in `pg_hba.conf` scoped to only that role+DB; all other
  roles still require passwords. `psql -U multiblog -h 127.0.0.1 -d multiblog` just works.
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
- `.env` (never committed): `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `COLLAB_PORT`,
  `NEXT_PUBLIC_COLLAB_URL`. Optional: `NEXT_PUBLIC_SITE_TITLE` (defaults to `"MultiBlog"`,
  `src/lib/site-config.ts`) — deliberately env-sourced rather than hardcoded so a real
  deployment's title survives `git pull` instead of living in a tracked file.
- Adding a **required** (non-nullable, no `@default`) column to a table that already has
  rows: `prisma migrate dev` normally prompts interactively for how to backfill existing
  rows, which doesn't work non-interactively. Instead, add the field nullable first and
  migrate, backfill via `psql`/a script, then drop the `?` and migrate again — the second
  migration is a plain `ALTER COLUMN ... SET NOT NULL` with no prompt, since every row
  already has a value by then. See `adminInitials`'s two migrations
  (`add_admin_initials_nullable`, `make_admin_initials_required`) for the pattern.

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
  call reports success and nothing happens (seen repeatedly on Publish in `PostEditor`).
  When a click appears to do nothing, drive it from `javascript_tool` instead:
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Publish').click()`
  dispatches a real React-visible click and works every time. Same for the
  `Published revision #N` link. Confirm the result via `get_page_text` rather than assuming.
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
  `Commenter` row for trust/moderation states), `scripts/test-post.ts` (create/delete
  posts, draft or published, with a moderation policy), `scripts/test-comment.ts`
  (list a post's comments and their statuses), `scripts/test-ydoc.ts` (create/list/delete
  standalone documents in the ydoc stack, PLAN.md §11 — `--from-post <id>` seeds one from
  a real post's latest revision, `--garbage` writes bytes that aren't a valid Yjs update at
  all, to exercise `/ydoc-debug`'s "not TipTap-compatible" error path on purpose). Each
  script's header comment documents its own flags — read that rather than a copy here,
  which is what will go stale. Defaults worth knowing without opening anything:
  `test-admin@example.com`, role `ADMIN`, password always `testpass123`.
- The first three refuse to touch anything but `@example.com` accounts and posts authored
  solely by them, so they can't reach real data by mistake. Delete a post *before* its
  author: once a post's only author is gone, "no authors" is indistinguishable from a
  real post that lost its author some other way, so `delete` refuses it. `test-ydoc.ts`
  uses the equivalent containment for a table with no email column: it only ever creates
  ids under the `ydoc:test-` prefix (`src/lib/ydoc-names.ts`) and refuses to `delete`
  anything else.
- The e2e suite needs none of this — its fixtures create and clean up their own rows
  (`e2e/db-worker.ts`, same `@example.com` guard, plus the `ydoc:test-` prefix guard for
  `e2e/ydoc-debug.spec.ts`), and a teardown project sweeps whatever a crashed run left
  behind.

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

- **Restarting the collab server while an editor tab is still open can duplicate a post's
  content.** `onLoadDocument` seeds the doc from the latest revision whenever no `PostCollab`
  row exists — and a killed server may never have flushed one (`onStoreDocument` is
  debounced), so the restarted server seeds a *second* copy, with fresh Yjs client ids, into a
  doc the reconnecting client already holds seeded content for. Yjs merges rather than
  deduplicates, and the post shows every paragraph twice. It's pre-existing (nothing to do
  with the title fragment) and only bites during dev restarts. Before restarting `collab`,
  navigate open editor tabs away; if it already happened, `DELETE FROM "PostCollabUpdate"` +
  `DELETE FROM "PostCollab"` for that post, restart collab again (the doubled doc is still in
  the old process's memory), then reload — it re-seeds cleanly from the revision, which was
  never touched.
- `npm run e2e` is a second way to trigger the above, not just a deliberate restart: if
  nothing is listening on :1234 it starts `npm run collab` itself and stops it when the run
  ends. Narrow in practice — with `dev:all` already up it reuses that and restarts nothing —
  but don't run the suite with an editor tab open against a collab server you didn't start.
- **The standalone ydoc stack (PLAN.md §11, `ydoc:`-prefixed documents, `/ydoc-debug`)
  does not have this doubling problem, and it's worth knowing why**, since it's the same
  restart and the same Hocuspocus process: `ydocOnLoadDocument` (`server/ydoc-hooks.ts`)
  creates its `ydoc` row *eagerly*, in `createIfAbsent`'s transaction, before any client's
  content is ever applied — never lazily off the first edit's debounced `onStoreDocument`
  the way `PostCollab` is. There's no window where a killed server has "never gotten around
  to" persisting a row, so a restart always finds one waiting and re-seeds from the actual
  same lineage instead of building a structurally new document from a revision. Confirmed by
  hand: restart `collab` with a `/ydoc-debug` editor tab left open and the content stays
  intact, typed-once, not doubled.
- **A doc (PLAN.md §12) inherits that same safety, but the repair recipe above still has no
  doc counterpart, and reaching for it by analogy would be actively wrong.** For a post,
  `PostCollab`/`PostCollabUpdate` are disposable — losing them costs only unsaved edits since
  the last save, because a revision always exists to re-seed from. A doc's `ydoc` row *is*
  the doc: there is no revision, and an annotation's anchor is a mark embedded in that exact
  row's content (§12i), not a position computed against it. Deleting `ydoc`/`ydoc_update` for
  a doc's id and letting it re-seed doesn't recover anything — there's nothing to re-seed
  from, and `createIfAbsent` would just build an *empty* document under that id, discarding
  every paragraph and every annotation the doc ever had. If a doc's `ydoc` row is ever
  genuinely corrupted, the only way back is the update log itself (`ydoc_update`, never
  truncated), replayed via `/ydoc-debug` (a doc's `ydoc:<docId>` row is just another entry
  in the same table an ADMIN can select there) — not a delete-and-restart.

## Gotchas

- `globals.css` has `* { margin: 0; padding: 0 }` — it strips default list/blockquote
  styling everywhere. `src/styles/prose.module.css` restores it for rendered post content;
  any new surface rendering post content needs its `.prose` class.
- `body` gets implicit `overflow-y: auto` (side effect of its `overflow-x: hidden`), and
  `documentElement` is the effective scroller — use `window.scrollY`, not
  `body.scrollTop`, when checking scroll behavior.
- TipTap v3's StarterKit already bundles Link and undo/redo: never add
  `@tiptap/extension-link` separately, and pass `undoRedo: false` when combining with the
  Collaboration extension. `@tiptap/extension-document`/`-paragraph`/`-text` *are* declared
  deps, which isn't a violation of that: they're for the **title** editor
  (`CollabTitleField.tsx`), which registers no StarterKit at all, so nothing is double-
  registered. Pin them to the same exact version as `@tiptap/core` when installing —
  `^3.28.0` resolves to 3.29.0, whose peer dep is `@tiptap/core@3.29.0` exactly, and npm
  fails the install.
- **TipTap v3's `setContent` takes an options object where v2 took a boolean**:
  `editor.commands.setContent(json, { emitUpdate: false })`, not `setContent(json, false)`.
  The v2 form is a type error (`Type 'false' has no properties in common with type
  'SetContentOptions'`) but reads as obviously-correct against any pre-v3 example or answer,
  so it's worth recognizing rather than re-deriving. Used by `LiveDocBody.tsx` to push live
  Yjs updates into a non-`Collaboration` editor without re-emitting them.
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
  that treats empty-means-empty (a title-changed comparison, a save) sees "" as real content.
  `HocuspocusProvider`'s own `onSynced` is the signal for that — see `providerSynced` in
  `PostEditor.tsx`. `onFirstRender` also fires *during* `useEditor`'s render, so calling a
  parent `setState` from it trips React's "state update on a component that hasn't mounted
  yet"; report upward from an effect instead (`CollabTitleField.tsx`).
- `document.querySelector('.tiptap')` now matches the **title** editor first — the body editor
  is `querySelectorAll('.tiptap')[1]`. Relevant to the editing-latency benchmark and
  content-setting recipes above, which target `.tiptap`. Both editors also carry an
  `aria-label` (`Title` / `Post body`) on their contenteditable, which is what the e2e
  suite keys off instead of DOM order.
- ProseMirror drops custom attributes where inline decorations overlap; the quote-highlight
  extension pre-splits ranges into non-overlapping segments (`data-thread-ids`, plural).
- `authorHighlight` marks (per-author color-coding, `src/lib/author-highlight-extension.ts`)
  live in the working Yjs doc and nothing else ever removes them — stripping them from
  `revisions.doc` (`stripMarkFromDoc`) keeps them out of published/historical content, but
  the *live* editor still shows them forever unless something clears the doc itself. See
  `clearAuthorHighlights` in `PostEditor.tsx`: a plain `removeMark` transaction dispatched
  after a successful save, synced like any other edit so every connected client (and anyone
  reconnecting later) sees the reset.
- The `PostCollabUpdate` replay log (`server/collab.ts`'s `onChange`) can't just append every
  delta — a delta's inserted text references *origin* items (the paragraph, prior text) that
  may predate the log's current generation. Whenever the log is empty (fresh session, or
  right after a save reset it), the first `onChange` stores the *full* current state instead
  of the one delta; only later changes store plain deltas. Skipping this makes replay from an
  empty scratch `Y.Doc` silently produce nothing (Yjs queues the delta as a missing
  dependency rather than erroring).
- `CollaborationCaret`'s default `render` shows an always-visible name label. We override it
  (`renderCaret` in `CollabEditorBody.tsx`) to draw just a colored bar, with the name in a
  CSS `:hover`-only tooltip (`.collabCaret`/`.collabCaretLabel` in `PostEditor.module.css`).
  The local user's own cursor was never affected either way — y-prosemirror's cursor plugin
  filters out the local clientID before `render` is ever called.
- A flex item's `flex-grow`/`flex-shrink` only has a budget to work with if its flex
  *container* has a definite (not `min-height`-only) main size — `min-height` lets the
  container's own size fall back to its content's, which defeats grow/shrink on children
  entirely. `body` (`globals.css`) sets `height: 100vh`/`100dvh` for exactly this reason: it's
  what lets `PostEditor.module.css`'s `.container` (and everything nested under it —
  `.editorFrame` → `.editorContent`) actually fill "the viewport minus the global
  `SiteHeader`" instead of silently reverting to content-based sizing and producing an
  always-present page scrollbar.
- Sizing something as "half of the heading it sits next to" needs `em` (relative to the
  *immediate parent's* font-size), not `rem` (relative to the *root* font-size) — `rem` gives
  you "half of whatever the root/site-header text renders at," which is a different, usually
  smaller, number than the actual surrounding `h1`/`h2`. `PostEditBadge.tsx`'s
  `(edit)`/`(edited)` link learned this the hard way: `0.5rem` came out as a *quarter* of the
  `h1` on the single-post page (32px) and a *third* of the `h2` in listings (24px), both
  because it was computing against the root's 16px instead of either heading's own size.
- `PostCollab` (`ydoc`, one row per post, `server/collab.ts`) is only ever created by
  `onStoreDocument`, which Hocuspocus fires from the shared doc's `update` event — an event
  listener attached *after* `onLoadDocument` finishes seeding the doc, so merely opening the
  editor never creates a row; it takes a real edit. But nothing ever deletes it — `saveDraft`/
  `publishPost` only clear `PostCollabUpdate` (the replay log), not `PostCollab` itself — so
  once a post has been edited even once, the row persists forever, including long after that
  edit was saved into a revision. Its existence therefore answers "has this doc ever
  diverged," not "are there unsaved edits right now." `src/lib/post-edit-status.ts` answers
  the second question by comparing `PostCollab.updatedAt` against the latest `Revision`'s
  `createdAt` — a cheap heuristic (can false-positive after a type-then-undo-to-net-zero
  edit), not a real diff against the last saved revision.
- When matching one element's width to another's via `ResizeObserver` (e.g. `PostsTable`'s
  search box tracking the Title column's width): use the observed element's own
  `getBoundingClientRect().width` inside the callback, not the callback's own
  `entries[0].contentRect.width` — `contentRect` is always the *content* box (padding and
  border excluded) regardless of the element's `box-sizing`, so on a padded `<th>` it under-
  reports by the padding, and copying that value straight into another element's CSS `width`
  (itself `box-sizing: border-box` from the global reset) makes it visibly narrower than the
  element it's supposed to match.
- **Two independent document stacks share one Hocuspocus process and port** (PLAN.md §11):
  ordinary post documents (bare cuid `documentName`s, `server/collab.ts`'s own hooks,
  `post_collab`/`post_collab_update`) and the standalone ydoc stack (`ydoc:`-prefixed
  `documentName`s, `server/ydoc-hooks.ts`, the `ydoc`/`ydoc_update`/`ydoc_snapshot` tables).
  `isYdocDocument`/`YDOC_PREFIX` (`src/lib/ydoc-names.ts`) is the *only* thing that tells
  them apart — every hook in `server/collab.ts` (`onLoadDocument`/`onChange`/
  `onStoreDocument`/`onAuthenticate`/`onRequest`) starts with a one-line guard that
  delegates to the other module for a `ydoc:` name and otherwise falls through to its
  original, untouched body. Adding a third stack (or moving posts onto the new tables)
  means adding a branch here, not restructuring what's already there. A ydoc-stack
  document is never seeded from a `Revision` — that coupling is exactly what the new
  tables exist not to have — so a `ydoc:` name nobody has explicitly created via
  `scripts/test-ydoc.ts` or `/ydoc-debug`'s "New document" button just starts empty.
- **`y-indexeddb`, used only by `/ydoc-debug`'s editor** (`src/lib/ydoc-persistence.ts`;
  `PostEditor.tsx` doesn't use it — see PLAN.md §11e): never construct a second
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
