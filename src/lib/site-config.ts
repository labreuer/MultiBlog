// Edits to this file (or to NEXT_PUBLIC_SITE_TITLE below) require a
// dev-server restart (or a new deploy in production) to appear on the site —
// see CLAUDE.md's "Running" section for why: values here are read once at
// module load, not per-request.
//
// Sourced from an env var, not hardcoded, specifically so a real deployment
// can set its own title in .env (gitignored) without that customization
// living in a tracked file — a `git pull` can't revert what it never
// touched. NEXT_PUBLIC_ (not a bare env var) because SiteHeader.tsx imports
// this constant directly and is a "use client" component: only
// NEXT_PUBLIC_-prefixed vars are inlined into the browser bundle, at build
// time, same as every other value here.
export const SITE_TITLE = process.env.NEXT_PUBLIC_SITE_TITLE ?? "MultiBlog";
