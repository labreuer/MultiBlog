# Caching Notes

Running log of caching behavior, trade-offs, and decisions across the app.
Add a new dated entry below for each notable finding — most recent last.

## 2026-07-20 — Edit badge broke ISR on the home and author pages

Adding the "(edit)"/"(edited)" badge (`src/components/PostEditBadge.tsx`,
`src/lib/post-edit-status.ts`) required knowing who's viewing the page, so
`src/app/page.tsx` and `src/app/authors/[id]/page.tsx` each gained a call to
`auth()`.

Both pages had `export const revalidate = 60` — Next.js ISR, meaning the
rendered HTML was cached and shared across all visitors, regenerated in the
background at most once per 60s. `auth()` reads the session cookie, and
Next.js treats any route that reads cookies/headers as dynamic: it now
renders fresh on every request instead of serving the shared cached page.
`revalidate = 60` is still present in both files but is now a no-op — there
is nothing left to revalidate since the page is never statically cached in
the first place.

This is the correct trade-off for what the badge does (it must reflect the
actual viewer's edit permission and pending-edit state, which can't be
baked into a shared cached page), but it's a real regression in cache-ability
that a reviewer could otherwise mistake for the `revalidate` export still
doing something. `src/app/[slug]/page.tsx` also has `revalidate = 60` and
also calls `auth()` — but that page already called `auth()` before this
feature (for the commenter's display name), so it was already fully dynamic;
no new regression there. `src/app/search/page.tsx` has no `revalidate`
export and reads `searchParams`, which already forces dynamic rendering
regardless of `auth()`.

**Not fixed.** If the home/author pages' shared-cache behavior matters
enough to restore, the fix is to split the personalized part out: keep the
post list itself statically generated/ISR'd, and fetch each post's edit
status client-side (or via a small per-page server action) after the static
shell loads — at the cost of the badge popping in slightly after the rest of
the page rather than being present in the initial HTML.
