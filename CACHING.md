# Caching Notes

Running log of caching behavior, trade-offs, and decisions across the app.
Add a new dated entry below for each notable finding — most recent last.

## 2026-07-20 — Edit badge broke ISR on the home and author pages

*(`PostEditBadge` and the two entries below about it are gone as of PLAN.md
§15, 2026-07-30 — a published post is a static snapshot with no live-edit
staleness signal at all now, by decision. Left in place as history; the file
reference below was wrong even at the time — the heuristic it names lived
inline in `PostEditBadge.tsx`, not a separate `post-edit-status.ts`.)*

Adding the "(edit)"/"(edited)" badge (`src/components/PostEditBadge.tsx`)
required knowing who's viewing the page, so
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
`publishPost`/`unpublishPost` (`src/app/actions/posts.ts` — the publish action is now
`publishPostFromDoc`, PLAN.md §15, same `revalidatePublicPaths` call) only ever called
`revalidatePath` for the *admin* surfaces (`/posts/[id]/edit`, `/posts/[id]/history`,
`/posts`) — never for the
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

*(`PostEditor.tsx` is gone as of PLAN.md §15 — `PostPublisher.tsx`, its replacement, has no
"view published post" link of its own at all, so this specific staleness path isn't
currently exercised by anything in the editor. The lesson still applies to `PostsTable.tsx`'s
`Published` column link, which is a plain `<Link>` to `/${slug}` and always has been — see
the "still unverified" paragraph below, unchanged by this rewrite.)*

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

## 2026-07-29 — `/doc/[slug]` (PLAN.md §12) is dynamic by design, and doesn't need ISR to be cheap

Unlike `/[slug]`, `/doc/[slug]` gets no `generateStaticParams` and is never a Full Route Cache
candidate — every request calls `auth()` (per-user gating, PRIVATE vs. SHARED) and would throw
`DYNAMIC_SERVER_USAGE` at build if it tried to be both static and dynamic (§10 item 17's bug,
`/[slug]`'s own history). That's not a caching gap to close: a *post* page's cost without ISR
would be a Yjs decode plus a ProseMirror render on every request, which ISR exists specifically
to avoid paying repeatedly. A *doc* page's steady-state cost is one row read — `Doc.proseJson`
(§12d) is a plain `JSONB` column populated by the collab server's own store debounce, so the
expensive half (decoding the live `ydoc` blob) already happened once, off the request path,
before any reader shows up. `renderToReactElement` over that cached JSON is the same
per-request cost `/[slug]` pays for its own (revision-cached, not live-cached) content.

The one path that's genuinely uncached is the decode-from-`ydoc` fallback for a doc that's been
created but never stored yet (`proseJson` still `null`) — cheap in practice since it only ever
applies to a brand-new, empty-or-near-empty document, not a large one.

None of this touches the live half. `LiveDocBody` (`src/components/LiveDocBody.tsx`) opens its
own read-only Hocuspocus connection independent of the HTTP response and re-renders in the
browser on every synced update — a second, always-fresh path with no cache of its own to
invalidate, the same way `AnnotatableArticle`'s live editor swap-in works for a post.

## 2026-08-04 — Contributor avatars: why a route beat a base64 data URI

Self-hosting the landing page's contributor avatars (PLAN.md §17n) presented as a
binary — keep a remote URL, or store the bytes and inline them as a base64 data
URI. It isn't one. "Store the bytes" and "serve them as base64" are orthogonal,
and the second is the part that would have been wrong *here specifically*.

`/` is ISR-cached (`revalidate = 60`, §17a) — a shared HTML artifact regenerated
at most once a minute and served to everyone in between. A data URI becomes part
of that artifact. Concretely, that means:

- the bytes are re-sent in full on **every** page load, by every visitor, forever
  — the browser has no separate cache entry to hit, because there is no separate
  resource;
- they are re-serialized into the ISR cache entry on every regeneration;
- there is no `ETag`, so no conditional request is even expressible;
- `next/image` can never touch them.

At five contributors × ~5KB that is ~25KB welded onto every load of the site's
most-visited page, permanently. The counterargument is real but narrow: under
~1–4KB inlining saves a round trip, and a 40px avatar is genuinely in that
range — but that's a *cold-first-visit* win, and a blog front page is dominated
by repeat visits, where a cacheable URL wins outright.

So the bytes live in Postgres (`user_avatar`) and are served from
`/api/avatar/<userId>/<hash>`.

**The hash in the path is what makes `immutable` honest.** It's a content hash,
so replacing an avatar changes the URL. The handler answers
`Cache-Control: public, max-age=31536000, immutable` with an `ETag` of the same
hash, and a conditional request gets a 304. Nothing has to guess at a TTL,
because the URL never outlives its content.

**The ISR window creates one case worth naming.** `/`'s HTML is cached for up to
60s, so a reader can hold HTML that references a hash which was current at
generation time and isn't now. 404ing that would show a broken image for the
rest of the window. The handler instead serves the *current* bytes — the reader
sees the right face — but downgrades that response to
`max-age=0, must-revalidate`, since a URL whose content just moved shouldn't be
claiming immutability. Fresh and stale are the same lookup; only the header
differs.

Verified against the running app: a matching `If-None-Match` returns 304 with the
`immutable` header intact; a stale path hash returns 200 with `must-revalidate`
and the correct current body length; an unknown user returns 404.

The 2026-07-24 finding still applies unchanged — `revalidatePath` reaches the
server's Full Route Cache but not a browser's own copy. It doesn't bite here,
because an avatar's URL changes when its content does, so there is no stale
browser copy to invalidate in the first place. That is the same property the
content hash buys for the CDN case, arrived at from the other direction.

One deliberate non-caching consequence, recorded because it's the kind of thing
that surprises later: the avatars now ride along in `pg_dump` (DEPLOY.md §9),
roughly 5KB per contributor, exactly as the ydoc `BYTEA` already does.

## 2026-08-05 — Site icons: the cache that "clear cache" doesn't clear

Favicons don't live in the caches this file has otherwise been about. Chrome
keeps them in a separate `Favicons` SQLite table keyed by page URL, with its
own freshness heuristic — "Empty cache and hard reload" does not touch it, and
neither does anything else short of the URL itself changing. That ruled out
the shape every other piece of deployment content in this app uses
(`SITE_BANNER`: gitignored file, stable `public/` path, restart to pick up a
change) — a stable-path favicon is exactly the shape that gets stuck.

The fix (docs/FAVICON.md) is a content hash in the URL, computed two
different ways depending on who can see the bytes:

- **`src/app/icon.png`, `icon1.png`, `apple-icon.png`** — Next's own
  `next-metadata-image-loader.js` already content-hashes these into the
  emitted `<link>` href at build time. Free, verified against `next@16.2.11`,
  no code required.
- **`public/icons/*.png`** (the manifest's PWA icons) — plain static files
  under `public/` get none of that. `src/app/manifest.ts` hashes them itself
  at request time (`createHash("sha256")` over the file bytes, `?v=<hash>`),
  the same shape §17n's `avatarHash` uses minus the database — there's no row
  to persist it in, so it's recomputed on read instead of stored on write.

**One inversion worth remembering:** `public/favicon.ico` deliberately gets
**no** `<link>` tag at all, unlike every hashed icon which gets one.
`resolve-metadata.js` `unshift`s an `app/favicon.ico` to the *front* of the
icon list — verified in the same version — so putting the file there instead
of in `public/` would have handed browsers an unhashed, permanently-stable URL
as a leading candidate, i.e. the exact staleness bug this entry is about,
reintroduced by the file living one directory over from where it needed to.
`public/favicon.ico` still exists and still isn't hashed, but nothing that
reads our own HTML ever points at it — it only answers a bare probe from a
client with no page to read a `<link>` from (a feed reader, a bare 404).

**Measured, not assumed:** `Cache-Control` on both the hashed file-convention
routes and `public/`'s static serving turned out to already be
`max-age=0`(`, must-revalidate` on the metadata-image route specifically) —
Next's own default, not something this app configured. So correctness here
never actually depended on the hash; a browser revalidates on every
navigation regardless. The hash's job is avoiding a redundant fetch once a
given hash is already cached — real, but not the reason changing the icon
now works where it didn't before.
