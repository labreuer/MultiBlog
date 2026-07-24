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

## 2026-07-23 — publish/unpublish weren't revalidating the pages they changed

Restoring real ISR above (entry directly above) meant `/`, `/[slug]`, and `/authors/[slug]`
went back to being cached with `revalidate = 60` instead of rendering fresh per request. But
`publishPost`/`unpublishPost` (`src/app/actions/posts.ts`) only ever called `revalidatePath`
for the *admin* surfaces (`/posts/[id]/edit`, `/posts/[id]/history`, `/posts`) — never for the
public pages whose `publishedPostWhere()` query result the action had just changed. A newly
published post wouldn't appear on `/` or its authors' `/authors/[slug]` pages, and an
unpublished post wouldn't disappear from them, until the next background revalidation (up to
60s later, and only then on the next request after that). `unpublishPost` alone happened to
revalidate the post's own `/${slug}` page; `publishPost` didn't even do that.

Fixed by adding a shared `revalidatePublicPaths(postId, slug)` helper that both actions call:
revalidates `/`, `/${slug}`, and `/authors/${authorSlug}` for every author on the post.
`schedulePost` doesn't need it — a scheduled post isn't in `publishedPostWhere()`'s result yet,
so there's nothing on those pages to invalidate.

## 2026-07-24 — `revalidatePath` fixed the server, but the *browser* still served stale

The entry above made the server side correct, and it is: publish a change, then request the
page, and you get the new content on the first hit. But an author who published an edit and
then clicked the editor's **"Published revision #N"** link still saw the old version — in the
same tab, seconds after publishing. Reloading fixed it. So the staleness lived entirely on
the client.

`revalidatePath` only reaches Next's *server-side* Full Route Cache. It cannot touch the
browser's **client-side Router Cache**, which holds RSC payloads per tab for routes that tab
has already visited or prefetched. Our public pages are prerendered, and Next tells the
browser how long it may reuse them:

```
x-nextjs-cache: HIT | STALE | MISS   ← server-side Full Route Cache state
x-nextjs-prerender: 1                ← this route is prerendered/ISR
x-nextjs-stale-time: 300             ← client Router Cache may reuse for 5 minutes
Cache-Control: s-maxage=60, stale-while-revalidate=31535940
```

Those headers are the fastest way to tell the two layers apart, and need no instrumentation —
`curl -sSI https://<host>/<slug>` answers "is the *server* stale?" directly. If the server
says it has fresh content but the browser shows old, the Router Cache is the only thing left
holding it. Note there is no `max-age`, and nginx is a pure pass-through (no `proxy_cache` in
`deploy/nginx-app.conf.sample`), so neither the browser's HTTP cache nor a CDN is ever
involved — those two layers are the whole story.

**Fixed** by making that one link a plain `<a>` instead of `<Link>`
(`src/components/PostEditor.tsx`). A hard navigation bypasses the Router Cache entirely and
loads the page the way an actual visitor would — which is what "view my published post"
should mean anyway. Confirmed working on production.

Two things worth knowing before touching this again:

- **`router.refresh()` in the link's `onClick` does not work**, and was tried first.
  `router.refresh()` refetches the route you are *currently* on — here, the editor — not the
  one you are navigating to, and it races the navigation besides. It looks plausible in a
  diff and does nothing.
- **A local `next build` + `next start` did not reproduce the bug**, across three probes:
  soft-navigating from `/` after a publish, the same but with the tab having already visited
  the post page (so a 300s entry existed), and a `stale-while-revalidate` probe (5 sequential
  requests after publish gave `MISS` with fresh content, then `HIT` — server behaving
  correctly). The local build otherwise matches production exactly, including all four headers
  above. So local prod-mode is the right place to test *most* caching behavior, but this
  particular symptom only ever showed on the real deployment — don't take a local pass as
  proof.

Still unverified: the home page, `/authors/[slug]`, and the `/posts` admin table all link to
post pages with plain `<Link>`, so the same Router Cache staleness is possible there in
principle. It never reproduced locally and hasn't been observed in production, so it's left
alone rather than pre-emptively converted — but it's the first place to look if "I published
and still see the old version" resurfaces from a different entry point.

### Testing production caching locally

`next dev` does not enforce the static/dynamic split or the Full Route Cache, so caching bugs
are invisible there. Production is a single `next start` behind a pass-through nginx — no CDN,
no cluster — so a local production build is a faithful reproduction:

```
npm run build
```

then run the `web-prod` entry in `.claude/launch.json` (port 3001, so it doesn't collide with
`dev:all` on 3000). That entry shells through `pwsh` to set `AUTH_TRUST_HOST`/`AUTH_URL`,
because NextAuth rejects `localhost:3001` with `UntrustedHost` under `next start` — the same
enforcement DEPLOY.md §5 warns about.
