# MultiBlog

A multi-author blog with post revisions, real-time collaborative editing, and
quote-anchored comments. See [PLAN.md](PLAN.md) for the full architecture and
design rationale.

## Prerequisites

- Node.js 20+
- PostgreSQL 18 (16 or newer works for a deployment — see [DEPLOY.md](DEPLOY.md))

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a database and point `.env` at it — `.env` is never committed and
   needs:

   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/multiblog?schema=public"
   AUTH_SECRET="<openssl rand -base64 32>"
   APP_URL="http://localhost:3000"
   COLLAB_PORT=1234
   # NEXT_PUBLIC_COLLAB_URL — leave unset locally; see docs/ENV.md
   ```

3. Generate the Prisma client and apply migrations:

   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```

## Running

```bash
npm run dev:all
```

Runs the Next.js app (`:3000`) and the Hocuspocus real-time collab server
(`:1234`) together via `concurrently` — one `Ctrl+C` stops both. Individually:
`npm run dev` (web only) or `npm run collab` (collab only). `npm run
stop:all` stops a `dev:all` you started elsewhere.

## Checks

```bash
npx tsc --noEmit   # typecheck
npx eslint .       # lint
npm run e2e        # full Playwright suite, against a production build
```

## Documentation

Start with [PLAN.md](PLAN.md); everything else is reached from there or from
[CLAUDE.md](CLAUDE.md), which indexes the lot.

**Design and progress**

- [PLAN.md](PLAN.md) — architecture, design decisions, and build progress.
- [TODO.md](TODO.md) — open items carrying enough context to act on directly.
- [CLAUDE.md](CLAUDE.md) — notes for AI coding agents working in this repo, and
  the index to everything below.

**Subsystems** (`docs/`)

- [docs/COLLAB.md](docs/COLLAB.md) — how a comment or annotation stays attached
  to a passage while the passage moves; every strategy used and rejected.
- [docs/YDOC.md](docs/YDOC.md) — the Yjs document stack: one collab process, the
  `ydoc*` tables, restarts, and local IndexedDB persistence.
- [docs/TIPTAP.md](docs/TIPTAP.md) — TipTap/ProseMirror gotchas.
- [docs/PDF.md](docs/PDF.md) — the PDF viewer, external annotations, file
  storage, and pdfjs version coupling.
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — who may do what, per role and
  visibility.
- [docs/EMAIL.md](docs/EMAIL.md) — mail delivery, rate limiting, and invites.
- [docs/DOC_IMPORT.md](docs/DOC_IMPORT.md) — creating a doc from Markdown.
- [docs/FAVICON.md](docs/FAVICON.md) — site icons and the web manifest.

**Working on it**

- [docs/ENV.md](docs/ENV.md) — every environment variable, and which ones need a
  restart rather than a rebuild.
- [docs/DEV_SLOTS.md](docs/DEV_SLOTS.md) — running two working trees side by side.
- [docs/DATABASE.md](docs/DATABASE.md) — the Postgres cluster and migration recipes.
- [docs/TEST_DATA.md](docs/TEST_DATA.md) — throwaway fixtures, sample data, imports.
- [docs/BROWSER_PANE.md](docs/BROWSER_PANE.md) — driving the preview browser.
- [e2e/README.md](e2e/README.md) — the Playwright suite and its fixtures.

**Cross-cutting**

- [STYLE.md](STYLE.md) — styling conventions (colors, typography, CSS Modules
  vs. inline, layout, scrollbars).
- [PERFORMANCE.md](PERFORMANCE.md) — performance findings, the opt-in
  perf-logging tool, and how to measure.
- [CACHING.md](CACHING.md) — caching behavior and trade-offs (ISR, etc.).
- [DEPLOY.md](DEPLOY.md) — deploying to a self-managed Linode/Ubuntu box.
