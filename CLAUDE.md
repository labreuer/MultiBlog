# MultiBlog — notes for Claude

Multi-author blog with revisions, real-time collab, and quote-anchored comments.
Architecture and build order: [PLAN.md](PLAN.md) — §10 tracks what's actually built vs. planned.
Performance findings and the opt-in perf-logging tool: [PERFORMANCE.md](PERFORMANCE.md).

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

## Checks & verification

- Typecheck `npx tsc --noEmit`; lint `npx eslint .`. No test suite yet.
- Verify changes live in the browser pane before reporting them done.
- The `computer` screenshot action reliably times out in this environment — verify with
  `read_page` / `javascript_tool` measurements (bounding rects, computed styles) instead.
- The browser pane's console buffer accumulates across navigations; for a clean error
  check, open a fresh tab.
- To verify a concurrent-editing feature, sign up two throwaway accounts
  (`something@example.com` / any password via `/sign-up`), promote to ADMIN with
  `psql -U multiblog -h 127.0.0.1 -d multiblog -c "UPDATE \"User\" SET role='ADMIN' WHERE
  email='...'"` (new sign-ups default to COMMENTER and can't edit posts), and delete both
  the test `Post` row and the `User` rows when done.
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

## Conventions

- Commit only when the user explicitly asks. Commit messages explain *why*, not just what.
- Inline styles are the norm; CSS Modules only where media queries/pseudo-classes are needed.
- Flag deviations from PLAN.md and judgment calls explicitly when reporting work.
