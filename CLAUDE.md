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
- `.claude/launch.json` defines `web` and `collab` for the preview tool.
- The user often runs `dev:all` themselves. If port 3000 is held by a non-preview node
  process, don't kill it — open the browser pane directly on http://localhost:3000.

## Database

- Local Postgres 14 (Windows service `postgresql-x64-14`). Role/DB `multiblog` connects
  passwordless via trust entries in `pg_hba.conf` scoped to only that role+DB; all other
  roles still require passwords. `psql -U multiblog -h 127.0.0.1 -d multiblog` just works.
- Restarting the Postgres service needs an elevated shell — ask the user to do it.
- `npx prisma generate` fails with EPERM while the dev server runs (query-engine DLL is
  locked). Stop `dev:all`, generate, restart.
- Generated Prisma client lives at `src/generated/prisma` (gitignored). Import from
  `@/generated/prisma/client` and `@/generated/prisma/enums`.
- One-off DB scripts (seeding/inspecting data outside the app) can't `require()` the
  generated client with plain `node -e` — it's TS source, not compiled JS. Write a `.ts`
  file importing `prisma` from `./src/lib/prisma` (same as `server/collab.ts` does) and run
  it with `npx tsx that-file.ts` from the project root; delete the file afterward.
- Dev account `labreuer@gmail.com` has role ADMIN.
- `.env` (never committed): `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `COLLAB_PORT`,
  `NEXT_PUBLIC_COLLAB_URL`.
- Adding a **required** (non-nullable, no `@default`) column to a table that already has
  rows: `prisma migrate dev` normally prompts interactively for how to backfill existing
  rows, which doesn't work non-interactively. Instead, add the field nullable first and
  migrate, backfill via `psql`/a script, then drop the `?` and migrate again — the second
  migration is a plain `ALTER COLUMN ... SET NOT NULL` with no prompt, since every row
  already has a value by then. See `adminInitials`'s two migrations
  (`add_admin_initials_nullable`, `make_admin_initials_required`) for the pattern.

## Checks & verification

- Typecheck `npx tsc --noEmit`; lint `npx eslint .`. No test suite yet.
- Verify changes live in the browser pane before reporting them done.
- The `computer` screenshot action reliably times out in this environment — verify with
  `read_page` / `javascript_tool` measurements (bounding rects, computed styles) instead.
- The browser pane's console buffer accumulates across navigations; for a clean error
  check, open a fresh tab.
- For a throwaway ADMIN account (most manual testing — e.g. exercising publish/
  unpublish/schedule), use `npx tsx scripts/test-admin.ts create [email] [name]`
  (defaults to `test-admin@example.com`; password is always `testpass123`) and
  `... delete [email]` when done — one command each way instead of sign-up +
  psql-promote + psql-delete. Restricted to `@example.com` addresses, so it
  can't touch a real account even by mistake.
- To verify a concurrent-editing feature specifically, you need **two** such
  accounts signed in in separate browser tabs at once — run `create` twice
  with different emails, and delete both (plus any throwaway `Post` row) when
  done.
- For throwaway posts (content to publish/unpublish/schedule, or a copy of
  real content for perf testing per below), use `npx tsx scripts/test-post.ts
  create [authorEmail] [title]` and `... delete [slugOrId]` instead of a
  manual DB script each time. `create` requires an existing `@example.com`
  author (make one with `test-admin.ts create` first); `delete` refuses any
  post that has a non-`@example.com` author. Delete the post before deleting
  its author — once a post's only author is gone, "no authors" is
  indistinguishable from a real post that lost its author some other way, so
  `delete` refuses those too.
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
  reload a tab when you actually mean to switch who it's authenticated as.
- For editing-latency benchmarks, `document.execCommand('insertText', false, char)` in a
  loop inside the editor's `.tiptap` element, timed with `performance.now()` per call, drives
  a real ProseMirror transaction through the normal path (mark-tagging, Yjs sync,
  decorations) without OS input-pipeline noise — reproducible enough for relative
  before/after comparisons. `execCommand('delete', false)` undoes it the same way,
  character-for-character, to restore test content afterward.
- To A/B a performance change against actual history rather than guessing: confirm
  `git status` is clean, `git checkout <old-commit>`, stop/restart `dev:all` (checkout
  doesn't hot-reload cleanly across many files — the collab server especially needs a real
  restart), measure, then `git checkout <branch-name>` and restart again.
- For performance/stress testing at a realistic content size, copy the target content into
  a throwaway post rather than editing the real one directly — removes any risk from a
  botched restore step.

## Gotchas

- `globals.css` has `* { margin: 0; padding: 0 }` — it strips default list/blockquote
  styling everywhere. `src/styles/prose.module.css` restores it for rendered post content;
  any new surface rendering post content needs its `.prose` class.
- `body` gets implicit `overflow-y: auto` (side effect of its `overflow-x: hidden`), and
  `documentElement` is the effective scroller — use `window.scrollY`, not
  `body.scrollTop`, when checking scroll behavior.
- TipTap v3's StarterKit already bundles Link and undo/redo: never add
  `@tiptap/extension-link` separately, and pass `undoRedo: false` when combining with the
  Collaboration extension.
- The TipTap schema is shared by the editor, Hocuspocus doc-seeding, and public rendering
  via `src/lib/tiptap-schema.ts` — change it only there so the three can't drift.
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

## Conventions

- Commit only when the user explicitly asks. Commit messages explain *why*, not just what.
- Flag deviations from PLAN.md and judgment calls explicitly when reporting work.
