# MultiBlog — notes for Claude

Multi-author blog with revisions, real-time collab, and quote-anchored comments.
Architecture and build order: [PLAN.md](PLAN.md) — §10 tracks what's actually built vs. planned.

## Running

- `npm run dev:all` — web (Next.js, :3000) + collab (Hocuspocus, :1234) via concurrently;
  one Ctrl+C stops both. Individually: `npm run dev`, `npm run collab`.
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

## Conventions

- Commit only when the user explicitly asks. Commit messages explain *why*, not just what.
- Inline styles are the norm; CSS Modules only where media queries/pseudo-classes are needed.
- Flag deviations from PLAN.md and judgment calls explicitly when reporting work.
