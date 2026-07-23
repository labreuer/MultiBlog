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

## 2026-07-23 — Fixed: this was a production crash, not just lost caching

The entry above undersold the severity. It treated `auth()` forcing a route dynamic as
purely "loses the shared cache" — true for the home and author pages, which have no
`generateStaticParams`. But `src/app/[slug]/page.tsx` **does** call `generateStaticParams()`
(PLAN.md §10 item 4), and a route that's both eligible for static generation *and* calls a
dynamic API during that attempt doesn't gracefully fall back to per-request rendering — it
throws `DYNAMIC_SERVER_USAGE`, a hard error. That only surfaces under a real `next build`/
`next start` (`next dev` doesn't enforce the static/dynamic split the same way), which is why
it went unnoticed until the first production deploy: every published post page 500'd.

Fixed by moving every viewer-identity-dependent read off the server entirely — `SiteHeader`,
`PostEditBadge`, `CommentForm`, `CommentNode`, and `CommentSection` no longer call `auth()`
anywhere in their render path. A `SessionProvider` (root layout) backs `useSession()` calls
at each of those leaf components instead — the client-side split this file proposed above,
now actually done. `src/lib/role-checks.ts` was split out of `authz.ts` (which imports
Prisma) so these client components can import the pure `canEditAnyPost`/`isAdmin`/
`canManagePosts` checks without risking Prisma in the browser bundle.

Result: `/`, `/[slug]`, and `/authors/[slug]` are all genuinely static/ISR/SSG again —
confirmed via `next build`'s route summary (`/` and `/[slug]` both show prerendered) and a
full `next start` pass with a clean console. The UX cost this entry predicted is real: the
edit badge and comment-form name prefill now pop in a moment after the rest of the page,
once the client-side session fetch resolves, instead of being present in the initial HTML.
