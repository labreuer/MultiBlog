# MultiBlog

A multi-author blog with post revisions, real-time collaborative editing, and
quote-anchored comments. See [PLAN.md](PLAN.md) for the full architecture and
design rationale.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+

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
   NEXT_PUBLIC_COLLAB_URL="ws://localhost:1234"
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
```

No test suite yet.

## Documentation

- [PLAN.md](PLAN.md) — architecture, design decisions, and build progress.
- [DEPLOY.md](DEPLOY.md) — deploying to a self-managed Linode/Ubuntu box.
- [CACHING.md](CACHING.md) — caching behavior and trade-offs (ISR, etc.).
- [PERFORMANCE.md](PERFORMANCE.md) — performance findings and the opt-in
  perf-logging tool.
- [STYLE.md](STYLE.md) — styling conventions (colors, typography, CSS Modules
  vs. inline).
- [TIPTAP.md](TIPTAP.md) — TipTap/ProseMirror gotchas.
- [CLAUDE.md](CLAUDE.md) — notes for AI coding agents working in this repo.
