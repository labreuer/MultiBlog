# The blog: what readers see

The public side of the blog, as built:

1. the landing page;
2. a post's dated URL;
3. the date archives;
4. the links between a post's three pages;
5. the one order every listing uses;
6. the numbered pages after the landing page;
7. each post's older and newer neighbours.

§8 is what is cached and what keeps each page fresh, §9 what is not built, and §10 the tests.

Some of it lives elsewhere:

- **PLAN.md §15** is what a post *is*, a snapshot of a doc, and §3d the post editor.
- **PLAN.md §17e–§17i** is the contributor list on the landing page, and §17n–§17o its
  avatars.
- **CACHING.md** has the caching findings, with their dates.

PLAN.md §17, §21 and §25 point here.

---

## 1. The landing page

`/` (`src/app/page.tsx`) holds four blocks:

- a **banner**;
- a **preamble** taken from a doc;
- the **latest posts**;
- a **contributor list**, in a right-hand column that moves below the posts on a narrow
  screen.

All four are the same for every reader.

### It reads no session

`/` is cached, with `revalidate = 60` (§8), and that cache is shared only while nothing in
its tree reads the viewer on the server. So there is **no `auth()`, `cookies()` or
`headers()`** in the page, the banner, the preamble or the contributor list (CACHING.md,
2026-07-20 and 2026-07-23). Anything that depends on the viewer is a client island that asks
after hydration, as the site header does. A contributor edits their own entry on
`/dashboard` (PLAN.md §17g), which is dynamic anyway.

### The banner

The banner is deployment content, not repository content: its path comes from the environment
and its file is gitignored (`/public/banner.*`). So `git pull` can't revert a deployment's
banner, which is the argument `NEXT_PUBLIC_SITE_TITLE` makes too (`src/lib/site-config.ts`).

```
SITE_BANNER="/banner.png"
SITE_BANNER_ASPECT="4724 / 1609"   # optional, 3 / 1 by default
SITE_BANNER_ALT=""                 # optional; empty is right for a decorative banner
SITE_BANNER_TEXT="…"               # optional; words instead of the image, and wins over it
SITE_BANNER_TEXT_SIZE="72px"       # optional, 72px by default
```

- **Its own module, `src/lib/site-banner.ts`.** `site-config.ts` is imported by
  `SiteHeader.tsx`, a client component, which is why `SITE_TITLE` there is `NEXT_PUBLIC_`. A
  bare `process.env` read added to that module would read `undefined` in the browser and
  quietly fall back. A module of its own makes "never readable from the client" a property of
  the file rather than a comment on a line.
- **Bare, not `NEXT_PUBLIC_`.** Every `NEXT_PUBLIC_` variable is baked in at `npm run build`
  (DEPLOY.md §4, docs/ENV.md). These are read on the server, so changing one needs a restart
  and no rebuild.
- **`next/image`, not `<img>`.** A banner is a large image, so it goes through Next's image
  optimizer. It renders `fill` inside a wrapper whose `aspect-ratio` is an inline style, with
  `object-fit: cover` and `priority`, since it is the page's largest paint. The aspect ratio
  is a per-deployment value, which is STYLE.md's bar for an inline style.
- **Swapping the file is slow to show.** `public/` is served from disk at runtime, so a new
  file needs no restart or rebuild. But the optimizer caches what it serves by URL for
  `minimumCacheTTL`, four hours by default (`next.config.ts` sets no `images`), and tells
  browsers to keep it as long. So a file swapped under the same name can show the old banner
  for hours. For a prompt change, give the new file a new name and point `SITE_BANNER` at it,
  which is a restart.
- **A text banner instead.** `SITE_BANNER_TEXT` sets the banner as words, centred in the
  reading serif at `SITE_BANNER_TEXT_SIZE`.
  - It is the page's `<h1>`, since unlike the decorative image it is the page's name.
  - When both are set the text wins, so switching an instance from image to text is one added
    line.
  - The size reaches CSS as the inline custom property `--banner-text-size`. `page.module.css`
    caps it at `10vw` with `text-wrap: balance`, so a title that fits a desktop row fits a
    phone, wrapping into even lines.
- **Neither set, no banner.** A `SITE_BANNER` that names a missing file isn't detected and
  hidden. The optimizer's request for it fails, and with the default empty alt text readers
  see an empty band in the banner's shape. That is a deployment error, and it is left to show.

### The preamble

The preamble is the body of the doc titled **`FRONT PAGE`** (`FRONT_PAGE_DOC_TITLE`), matched
case-insensitively by `getFrontPagePreamble` (`src/lib/front-page.ts`).

- **Only `proseJson` is selected**, so the title can't be shown: it is the selector, and it is
  never read.
- **First-created wins.** `Doc.title` has no unique constraint, since it is a cache of the
  ydoc's title fragment (docs/DOCS.md, "The caches"), so two docs can share it. Ordering by
  `createdAt` makes a second `FRONT PAGE` doc inert, rather than letting the page flip between
  two preambles. §10 has what this costs the tests.
- **Visibility is not consulted.** Requiring `SHARED` would be wrong on two counts. `SHARED`
  means "anyone with `canViewDocs`", a role gate, not the public (docs/DOCS.md, "Roles and
  visibility"). And it would make a `SHARED` doc look world-readable in the admin UI when it
  isn't. The title is the one switch. A doc's visibility still governs `/doc/<slug>`; a doc
  titled `FRONT PAGE` also has its body published anonymously here.
- **Its marks are stripped.** A doc's prose can carry `authorHighlight` and `annotation`
  marks, which `contentExtensions` doesn't know, and every public surface renders with
  `contentExtensions`. So the body goes through `stripMarksFromDoc(json, ["authorHighlight",
  "annotation"])`, as a post's snapshot does in `postContentFromYdoc`, before
  `renderToReactElement` renders it inside `.prose`. Unstripped, it would 500 the page.
- **A doc with no `proseJson` has no preamble.** The page leaves it out rather than decode the
  ydoc, as `/doc/[slug]` would, which would cost a row read and a Yjs decode on a statically
  generated page. The case barely arises: every path that gives a doc the title `FRONT PAGE`
  writes its `proseJson` in the same step.
- **"Preamble", not "blurb".** A contributor's blurb (PLAN.md §17f) is a plain `User` column,
  written by a server action and live at once. The preamble is a doc, collaboratively edited,
  that reaches the page through a debounced cache (§8). Two mechanisms get two words, and
  "preamble" implies no brevity: it can be several paragraphs. The identifiers follow the
  word (`getFrontPagePreamble`, `.preamble`). The title stays `FRONT PAGE`, since that is a
  string an editor types.
- **Seeding.** `scripts/seed-front-page.ts` creates the doc if none exists, and never clears
  anything, so it is safe on a database with real content. `scripts/seed-sample-data.ts`,
  which empties the content tables, doesn't create one (§9). The script creates the ydoc row
  eagerly, and seeds the title into the title fragment as well as the column; otherwise
  `server/doc-cache.ts` would write an empty title over the column on its first flush.

### The latest posts

The newest `POSTS_PER_PAGE` posts, ten, in `PostListing`'s preview block (§3). Under them is
the pager that continues the list on `/page/2` (§6).

### Contributors

`ContributorList` (`src/components/ContributorList.tsx`) renders the users an admin has listed
as contributors, from `getContributors` (`src/lib/contributors.ts`), each as a
`ContributorCard`. It reads no session either. Who is listed, what a card shows and how a
contributor edits their own is PLAN.md §17e–§17i. Their avatars are §17n–§17o.

### Layout

```css
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px;
          gap: 2.5rem; max-width: 1040px; margin: 0 auto; padding: 1rem; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
```

- **The contributor list comes second in DOM order**, so under 900px it flows below the posts
  with no `order` juggling, which is also the right reading order.
- **1040px is one of STYLE.md's centred-column widths**, not a drift from the 680px listing
  width. The main column inside it stays at about 680px, and the rest is the 280px sidebar
  and its gap (STYLE.md, "Breakpoints and centred-column widths").

---

## 2. A post's URL: `/yyyy/mm/dd/slug`

A published post lives at `/yyyy/mm/dd/slug`
(`src/app/[year]/[month]/[day]/[slug]/page.tsx`), the date being its `publishedAt` in UTC.
`src/lib/post-path.ts` is the one module that knows the shape: every link, revalidation and
byline goes through `postPath` and its siblings. It is browser-safe, so `PostsTable`, a client
component, can use it. Its server half is `src/lib/revalidate-post.ts`.

### The route

- **Prerendered, then cached.** `generateStaticParams` returns `{ year, month, day, slug }`
  for every published post, and `revalidate = 60` keeps each page fresh (§8).
- **No dynamic API, ever.** The page may not reach `auth()`, `cookies()` or `headers()`, and
  how a mistake shows depends on what reaches the call first.
  - If the build's prerender reaches it, Next makes the route dynamic without a word, and
    every post page loses its cache.
  - If only a request reaches it, such as one for a post published after the build, that
    request fails with `DYNAMIC_SERVER_USAGE` and a 500. Every post page did that, the one
    time it happened (CACHING.md, 2026-07-23 and 2026-10-23).

  So anything on the page that depends on the viewer is a client island (§4).
- **No route collisions, by Next's rules.** A static segment beats a dynamic one at the same
  position, so every route that starts with a static segment, such as `/post/…`, `/posts/…`,
  `/api/…`, `/authors/…`, `/doc/…` and `/page/…`, wins over `/[year]/…`. Every other route
  four segments deep starts with one.
- **It checks the shape before its first query.** The route matches any four-segment path
  nothing static claims, `/a/b/c/d` included. So `parsePostDateSegments` runs first, and the
  page 404s on null.
  - It accepts only a real calendar date, written exactly as `postDateParts` writes it: four
    digits, then two and two, zero-padded.
  - `generateMetadata` runs the same check, and the same canonical check (below), since it
    queries too.
  - Its rejections are unit-tested (§10).
- **`postPath` throws on a null `publishedAt`** rather than inventing a path. A post that has
  never had a date has no public page, and rows that came through `publishedPostWhere()` never
  reach that branch.

### The date is UTC

- **The date is `publishedAt`, and it holds still.**
  - `publishPostFromDoc` keeps an earlier go-live date across an unpublish and a republish:
    `post.publishedAt && post.publishedAt <= now ? post.publishedAt : now`.
  - `schedulePostFromDoc` refuses while a post is live, so a live post's date can't be pushed
    forward.
  - `unpublishPost` leaves `publishedAt` alone.

  So a post that comes down and goes back up keeps its URL.
- **UTC, always.** `publishedAt` is stored in UTC. Deriving the segments in the server's zone
  would let a deploy to a box in another zone silently move the URL of every post published
  near midnight. And it would let `generateStaticParams`, on the build machine, disagree with
  the request handler about where a post lives, which shows as a 404 on a page that exists.
- **The byline reads the same parts** (`postDateLabel`), so it can't disagree with the URL.
  The cost is a western reader's evening: a post published at 21:00 EDT on the 4th is dated
  the 5th.
- **No site timezone setting.** It would turn a derived value into configuration that silently
  rewrites every URL when it changes. If one is ever wanted, it reaches all of `post-path.ts`:
  `postDateParts`, the two shape checks (which round-trip through `Date.UTC`), the archives'
  ranges (UTC midnights) and `postDateTimeLabel` (which prints "UTC").

### Slugs are unique across the blog

`Post.slug` is unique globally, not per date, so `/2025/01/01/new-year` and
`/2026/01/01/new-year` can't both exist: the second gets `-2`. That is a cosmetic wart on a
rare case, and per-date uniqueness can still come later. It would need:

- a composite unique constraint;
- a different `postSlugInUse`;
- no unique constraint on `PostSlugHistory.slug`;
- a new meaning for a history row.

That is a second change, not part of this one. With uniqueness global, a post's slug works as
every other slug does:

- `postSlugInUse`, `changePostSlug` and `revertPostSlug` (`src/lib/post-slug.ts`);
- `PostSlugHistory`, and `SlugManager` (`src/components/SlugManager.tsx`);
- `REVERT_DISCARD_WINDOW_MS` (`src/lib/slug.ts`).

**No slug is reserved.** A post four segments deep can't be shadowed by a static route, and
everything else with a slug (docs, files, tags, authors) sits one level down with no static
sibling. So there is no reserved-slug list, and a post may be slugged `docs`.
`src/lib/slug.ts` says why there is no list.

**`SlugManager` shows the post's date path as its URL prefix** (`/post/[id]/slug`), from its
`publishedAt`. A scheduled post already has one, so it shows the path it will have when it
goes live, and unpublishing or cancelling a schedule leaves the date in place. A post that
never had a date shows the literal `/yyyy/mm/dd`, since an empty prefix would show a URL the
site doesn't serve.

### Redirects: an old slug or a stale date

Either case takes one permanent redirect (308) to the post's canonical `postPath`. Both match
on the slug alone and ignore the date the URL arrived with, so a stale date and a stale slug
are the same kind of miss.

- **A stale date.** When the slug is a published post's current one and the date isn't its
  date, the page redirects to the canonical path.
- **An old slug.** When the slug is no published post's current one, `resolveRedirectPath`
  looks it up in `PostSlugHistory`. If it belongs to a published post, the page redirects to
  that post's current path. A history entry for a post since unpublished or deleted 404s.

A post's URL can still move. If a live post is unpublished and then scheduled for a later
date, `publishedAt` becomes the new time. That is accepted, and the canonical redirect sends a
reader holding the old URL to the new one. The alternative was to refuse to schedule any post
that has ever been live.

There is no redirect from the flat `/<slug>` posts once had: no post URL had been published
anywhere when they moved, so nothing links to one. Such a path falls through to `/[year]` and
404s.

### No stored path

The path is derived from `publishedAt` wherever it is needed, and never stored. A stored path
column would freeze the URL against a later change to `publishedAt`, at the cost of a second
source of truth for what the publish actions already keep still.

### RSS

`/rss.xml` builds each item's `<link>` and `<guid>` with `postPath`, so an item's guid is the
post's dated URL (§9).

---

## 3. The date archives: `/yyyy`, `/yyyy/mm`, `/yyyy/mm/dd`

The three prefixes of a post's URL are pages. Each lists the posts published in that UTC
range, newest first (§5), under a breadcrumb of the levels above it: "All posts", the year,
the month. Trimming segments off a post's address lands somewhere sensible. And the byline's
date on every surface links to its day, so a reader can climb from any post to its day, month
and year.

- **Only posts already live.** The query takes `publishedPostWhere()` and the date range
  together, with an `AND`. Spreading `publishedPostWhere()` and adding the range would replace
  its own "not in the future" condition, and list a scheduled post's title and excerpt before
  it goes live.
- **Routing.** `src/app/[year]/page.tsx`, `[year]/[month]/page.tsx` and
  `[year]/[month]/[day]/page.tsx` are thin wrappers over `src/app/[year]/post-archive.tsx`.
  Each carries its own `revalidate = 60`, because Next reads segment config from the page
  file, not from what it imports. §8 has why that export does nothing today.
- **The shape check.** `/[year]` matches every one-segment path nothing static claims, such as
  `/tag` and `/doc` (which have no `page.tsx`), `/page`, or a stray `/favicon.ico` that misses
  `public/`. Its children match every two- and three-segment one. So `parsePostDatePrefix`
  (`src/lib/post-path.ts`) runs before the first query, and its rejections are unit-tested.
  - It returns a half-open UTC range with the label and the path. So the date arithmetic (a
    February is `[Feb 1, Mar 1)`, and a December ends at the next January) lives in one
    function rather than three route files.
  - Every page under `src/app/[year]/` checks its shape this way (CLAUDE.md).
- **Empty is not missing.** A well-formed date with nothing in it is a page: 200, "No posts
  published in …". Only a malformed one 404s.
- **Trailing slashes cost nothing.** `next.config.ts` sets neither `trailingSlash` nor
  `skipTrailingSlashRedirect`, so Next 308s `/2026/09/` to `/2026/09` before any route runs.
- **Rendered on every request** (§8).
- **Not paginated.** A year page lists every post in it (§9).

### The listing and the byline's date

**`PostListing`** (`src/components/PostListing.tsx`) is the one post-preview block: title,
byline, date and a 200-character excerpt. `/`, `/page/N`, the date archives and the author
pages render it. Each passes `postListingInclude` as its own query's `include`, so the query
and the component's props can't drift.

**`PostDate`** (`src/components/PostDate.tsx`) is the byline's date: the label, a link to the
day's archive, and the full timestamp as a native `title` tooltip.

- **The tooltip is UTC too**: `postDateTimeLabel`, as in `2026-09-15 21:03:47 UTC`. It is
  sliced from the ISO string with no `Intl`, so it renders the same on any server.
- **Not the reader's zone.** A tooltip in the reader's zone would say the 14th under a link to
  `/…/15` for a western reader. Its job is to explain the date shown, not contradict it. A
  local time, if one is ever wanted, is a second element (`LocalTime`), not a change to this
  one.

---

## 4. Getting between a post's pages

A post has three main pages: its doc (`/doc/[slug]`), its editor (`/post/[id]/edit`, with its
slug, history and comments pages beside it) and its public URL. Three links join them, chosen
so that the public page's server HTML is the same for every reader. The one link that depends
on the viewer arrives after hydration.

- **The public page carries one link.** `PostEditLink` (`src/components/PostEditLink.tsx`)
  adds "· configure post" after the byline's date, linking to the editor.
  - It shows for a viewer who may edit the post: an ADMIN or EDITOR, or an AUTHOR on the
    byline. It mirrors `canUserEditPost` as an affordance, and the editor's route keeps the
    gate.
  - It is a client island reading `useSession()`, as `TagStrip` is. That is what lets the page
    keep `generateStaticParams` and `revalidate`. The server renders nothing for it, so a
    signed-out reader's HTML is unchanged, and the link appears after hydration at the end of
    the line, where it moves nothing.
  - It is in the ordinary link colour rather than the byline's, being the one control on that
    line.
  - The byline's author ids ride along as a prop, for the AUTHOR case, since the session
    carries no slug to match on.
  - Weighed and not built:
    - the title as the edit link, as `DocView` does, which would make the whole `<h1>` an
      island and give the title link styling for authors;
    - a slot in `SiteHeader`, which sits above the page in the root layout and can't learn
      the post's id short of a store;
    - a keyboard shortcut alone, which nobody would discover.
- **The editor links out to the live post.** In `PostPublisher`, "Published <date>" links to
  the post's `postPath`, and is followed by "(publication history)". "From doc:" names the
  source doc and links as far as the viewer may go: to the doc editor for one who may edit it,
  to its reading view for one who may only read it, and nowhere for a PRIVATE doc they aren't
  on (PLAN.md §15i).
- **The doc's byline names its posts.** `DocPostsLine` (`src/components/DocPostsLine.tsx`) is
  the post line in `/doc/[slug]`'s byline, shown to a viewer who may edit the doc, since a
  schedule is not public information. With no post it *is* the "Publish as blog post" button.
  With posts it lists them, separated by `|`:
  - "Published on <yyyy-mm-dd>", linking to the public URL, then "(configure)" to the editor;
  - "Scheduled for <UTC timestamp> (in N days, N hours, N minutes)", linking to the editor,
    since there is nowhere public to go yet;
  - "Draft (configure)", for a post that is neither published nor scheduled: never published,
    unpublished, or with its schedule cancelled. The button would only make a second post, and
    this one needs somewhere to be found from.

  More about that line:
  - "as <post title>" is added when the post's title has diverged from the doc's.
  - The dates are UTC by §2's rule, rendered once on the server.
  - The countdown (`src/lib/duration.ts`) is computed per request on this dynamic page, and
    goes stale if a tab sits, which a reload fixes.
  - The doc page's query takes the doc's `posts` and filters out deleted ones by hand, since
    `resolveDocParam` reads through `prismaIncludingDeleted`.

There is no bare `/post/[id]` page. Nothing at `/post/[id]` reads a post, and every
"configure" link goes to `/post/[id]/edit`. A public URL that never changes isn't needed
either, since the slug-history redirect keeps old links working (§2).

---

## 5. One order for every listing

**Newest first by `publishedAt`, ties broken by `id`**: `postListOrderBy`
(`src/lib/post-pages.ts`).

- **Without the tie break**, two posts with one timestamp could swap between renders. A page
  boundary falling between them would then show one twice and the other never.
- **The listings that render `PostListing`, and the RSS feed, sort by it**: `/`, `/page/N`,
  the date archives, the author pages and `/rss.xml`. `/tag/[slug]`'s posts and `/search`
  keep orders of their own.
- **A post's neighbours walk the same order**, so "Older" from a post is the post below it in
  the listing.

**`@@index([publishedAt, id])` on `Post`** (migration `post_published_at_index`) serves the
listing's sort and offset, the archives' date ranges, and both neighbour lookups (§7).
Without it, each would be a sequential scan and a sort.

---

## 6. Pages after the first: `/page/N`

**Page 1 is `/`**, with a pager under its list: "← Older posts" and "Page 1 of M". Pages 2
and on are **`/page/N`** (`src/app/page/[n]/page.tsx`). Each holds the same `PostListing` in
the 680px listing column, under an "Older posts" heading, with no banner, preamble or
contributors. A pager sits above the list and another below it: "← Older posts" while there
is an older page, "Page N of M", and "Newer posts →".

- **`PostPager`** (`src/components/PostPager.tsx`) puts older on the left and newer on the
  right, the same timeline a post's neighbours run (§7).
  - It renders nothing when there is only one page.
  - Its links carry `rel="next"` for the older page and `rel="prev"` for the newer, since the
    pages are one series running from newest to oldest.
- **A path, not `?page=`.** Page 1 is `/`, and reading `searchParams` makes a route dynamic,
  which would cost `/` its cache (§1).
  - `/page/N` itself is rendered on every request, like the archives (§8). It keeps a
    `revalidate = 60` that would take effect if the route gained a `generateStaticParams`,
    which a query string could never do.
  - `/page/N` is also the URL WordPress and Hugo use.
- **The routing.** A static segment beats `[year]`, so `/page/2` never reaches the date
  archives. A bare `/page`, having no `page.tsx`, falls through to `[year]` and 404s there.
- **One page size, `POSTS_PER_PAGE = 10`**, which both routes import. The two are halves of
  one list, and if they disagreed, page 2 would repeat or skip posts.
- **It checks the segment before its first query**, as the date routes do (§2, §3).
  - `parsePageParam` accepts a positive integer with no leading zero or sign, up to six
    digits.
  - `/page/1` 308s to `/`, and anything else malformed 404s.
  - So does a page past the end, which, unlike an archive's empty day, names nothing.
- **The query** is `skip`/`take` over §5's order, plus a `count` for M.

**Offset rather than a cursor.** A cursor (`/before/<timestamp>`) never shifts under a reader,
but it has drawbacks:

- its URLs say nothing;
- every post's timestamp becomes its own page;
- "Page N of M" can't be shown.

The offset's cost is that every page shifts by one when a post is published, so a reader
paging back through the list just then can see a post twice or miss one. At this site's
publishing rate, that is acceptable.

---

## 7. Older and newer on a post

**`PostNeighbours`** (`src/components/PostNeighbours.tsx`) sits after the tag chips and before
the comments, so a long thread doesn't bury where to go next.

- **What it shows.** The older post on the left and the newer on the right, each as a small
  "← Older" or "Newer →" over the post's title.
  - A side with no post is left empty, so a lone "Newer" stays on the right.
  - At 480px and under the two stack, older first.
  - A rule above sets it off from the post. The comments' own top rule closes it, with none of
    their usual space above.
  - "← Back to all posts" stays at the foot of the page.
- **Older on the left, newer on the right, on both surfaces.** There is one timeline running
  left to right, on the pager (§6) and here.
  - Both say "older" and "newer", because "previous" and "next" mean opposite things on a
    listing and on a post.
  - Conventions differ. A numbered pager puts page 1, the newest, on the left, and some blogs
    put newer there to match; WordPress's default puts older on the left, as here. The single
    timeline is chosen over matching either.
- **`findPostNeighbours(post)`** (`src/lib/post-neighbours.ts`) is two `findFirst`s over
  `publishedPostWhere()`, one each side of the post's `(publishedAt, id)`. Each selects the
  slug and `publishedAt` that `postPath` needs, and the title for the link.
  - The comparisons are strict, so the post itself is never its own neighbour, whatever its
    state. §8 relies on that.
  - Each side also carries a plain bound on `publishedAt` beside the `OR` that breaks ties.
    It changes no result, but it is what Postgres can seek on: the `OR` alone stays a filter,
    and the scan would start at the newest or the oldest post and read its way along.
    Measured on 100,000 rows: about 56,000 filtered without the bound, none with it.
- **A Server Component reading no session**, as everything on the post page must (§2). So the
  page keeps `generateStaticParams` and `revalidate`, and at build, prerendering adds two
  small indexed queries per post.

---

## 8. Caching, and what each change refreshes

**What is cached.** Measured on a production build (CACHING.md, 2026-10-23):

- **Cached for 60 seconds**: `/`, every post page and `/rss.xml`. They answer
  `s-maxage=60, stale-while-revalidate` and `x-nextjs-cache: HIT`.
- **Rendered on every request**: the date archives, `/page/N` and the author pages. Each is a
  dynamic route with no `generateStaticParams`, which in this version of Next gets no cache,
  whatever its `revalidate` says. `next build` lists them as ƒ, and they answer
  `private, no-cache, no-store`.

So the `revalidate = 60` exports on those three, and the actions' calls to refresh them, do
nothing today. They are what would take effect if the routes gained `generateStaticParams`
(§9).

**What actions refresh.** Publishing, unpublishing and a slug change call
`revalidatePublicPaths` (`src/app/actions/posts.ts`) with the post's slug and `publishedAt`.
After a publish it passes the new values, since a first publish is when the path comes into
existence. Before an unpublish it passes the current ones. It refreshes:

- `/`, and every `/page/N` as the route pattern `/page/[n]` (`revalidatePostListPages`), since
  one post added or removed shifts every page after it;
- the post's own page (`revalidatePostPage`);
- its three archive pages (`revalidatePostArchives`);
- its neighbours' pages (`revalidatePostNeighbours`), found by the same `findPostNeighbours`
  the page renders with, so the two can't disagree about who they are;
- its authors' pages.

`revalidatePostPage` takes `{ slug, publishedAt }` and does nothing when `publishedAt` is
null, so any action can call it without first asking whether the post has a page.

Because the post is left out of its own neighbour lookup (§7), one call is right on both sides
of a change. After a publish, it finds the posts that now link to this one. After an
unpublish, it finds the two that did and now link to each other. After a slug change, it
finds the two whose links went stale. A slug change also refreshes the page at the old slug.

**Other changes:**

- **Deleting or restoring a published post** calls `revalidatePublicPaths` too
  (`setPostDeleted`). A draft or a scheduled post is on no public page, so for one it doesn't.
  A scheduled post whose time passed while it was deleted counts as published.
- **A comment** refreshes only the post's own page among the public ones, since it changes
  nothing a listing shows. That is why `revalidatePostArchives` is not folded into
  `revalidatePostPage`.
- **The contributor actions** (being listed, the order, the blurb, ORCID and website), both
  self-service (`src/app/actions/contributor.ts`) and admin (`src/app/actions/users.ts`),
  refresh `/` inline.

**What no action refreshes.** These wait out the 60 seconds:

- a scheduled post going live, which runs no action;
- `/rss.xml`;
- a change to a published post's byline (`updatePostAuthor`, `updatePostAuthorOrder`);
- a change to a user that shows on a byline or a contributor card: their name, colour,
  initials or slug, or their deletion. CACHING.md, 2026-09-17, leaves the renames unfixed on
  purpose.

**Preamble edits can't be pushed.** `Doc.proseJson` is written by the collab server's store
debounce (`server/doc-cache.ts`), a different process with no access to Next's
`revalidatePath`. So an edit to the `FRONT PAGE` doc reaches `/` after the debounce plus up
to 60s. A webhook from collab into the web app would close that gap, but isn't worth a
cross-process dependency for a preamble that changes a few times a year.

A contributor's blurb is the contrast. It is the same TipTap JSON, but written by a server
action in this process, so it revalidates inline. Which process owns a write decides whether
it can be pushed, not what the content is.

**Two notes on the mechanics:**

- `revalidatePath` reaches the server's cache, not the browser's. It doesn't reach Next's
  client Router Cache (CACHING.md, 2026-07-24), and on Firefox it doesn't reach the HTTP
  cache either (2026-09-14).
- The list in `revalidatePublicPaths` is kept by hand. TODO.md's "Past hobby scale", item 5,
  says when to stop enumerating it.

---

## 9. Known gaps, and what is not built

- **The date archives, `/page/N` and the author pages are not cached** (§8). A
  `generateStaticParams` returning `[]` is how a dynamic route gets cached on its first
  request in this version of Next. Not done, and not measured.
- **The banner has no admin surface.** It is environment and a file on disk, which is right
  for a self-hosted deployment and wrong once a non-technical editor wants to change it.
  `SiteSettings` is where it would go.
- **The date archives, author pages and tag pages are not paginated.** A year page lists every
  post in it (TODO.md, "Past hobby scale", item 1). `PostPager` takes a page and a count, and
  `postPagePath` is all of it that is tied to `/page/N`, so it could serve them.
- **An RSS item's guid is its URL.** A slug change, or a reschedule that moves the date, makes
  subscribers' readers show the post again as new.
- **No site timezone, and no per-date slugs** (§2).
- **No keyboard shortcuts** for older and newer.
- **No series or per-tag neighbours.** Neighbours are chronological across the whole blog.
- **`scripts/seed-sample-data.ts` creates no `FRONT PAGE` doc.** `scripts/seed-front-page.ts`
  is how to get one. Adding one to `SAMPLE_DOCS` has a catch: the script's safety check
  compares the number of docs with `SAMPLE_DOCS.length`, and that count would move by one.

---

## 10. Tests

**Unit tests** (`npm run test:unit`):

- **`src/lib/post-path.test.ts`** covers the URL's parts:
  - deriving them in UTC;
  - `postPath` refusing a post with no date;
  - the full-date and prefix checks' rejections;
  - the archives' half-open ranges.
- **`src/lib/post-pages.test.ts`** covers `parsePageParam`'s rejections, the page count's
  rounding and floor, and page 1's path.

**E2e specs:**

- **`e2e/landing.spec.ts`**'s one preamble test asserts only that the literal `FRONT PAGE`
  never reaches the page.
  - It asserts no preamble text: first-created-wins means a doc the spec makes loses to any
    `FRONT PAGE` doc already there.
  - Production determinism was judged worth more than test convenience; newest-wins would
    swap which of the two is easy.
  - The spec's other tests cover the contributor list, its move below the posts under 900px,
    the dashboard panel's edits reaching `/`, and avatars.
  - The banner is untested, being environment the suite doesn't control.
- **`e2e/date-archive.spec.ts`** uses a fixture post dated 2001-02-03, through
  `createTestPost`'s `publishedAt` option, which must be in the past. It finds its post by
  title, so the post `e2e/search.spec.ts` dates the same day doesn't disturb it. It also
  checks:
  - that a trailing slash lands on the bare URL;
  - that a post scheduled an hour ahead is on none of its three archives.
- **`e2e/publish.spec.ts`** drives `DocPostsLine`'s three kinds of entry and both link
  surfaces.
  - It reads a post's path back through `getPostPath(postId)` after the browser publishes,
    rather than assuming today, which crosses midnight in UTC eventually.
  - `TestPost.path` replaces hand-built URLs. It is null for a draft or a scheduled post, and
    a string on `PublishedTestPost`.
- **`e2e/pagination.spec.ts`** makes twelve posts dated 1999. That is older than anything else
  the suite makes, so they are always the listing's last twelve, however many pages the other
  specs' posts fill above them. Two of the posts share a timestamp. The spec checks:
  - `/` links to page 2;
  - the last page has no Older link and holds only the oldest of the twelve, in order, and
    the page before it ends with the rest, with nothing repeated or skipped at the boundary;
  - the tied pair and the oldest post link to the right neighbours, or to none;
  - following Older and then Newer comes back to the same post;
  - `/page/1` 308s to `/`, and a malformed page number or one past the end 404s.

  Its page checks retry, since another spec's post can move a boundary between two reads.

**Not covered:** the revalidation itself. Fixtures write straight to the database, so the specs
revalidate through `freshGoto` rather than through the actions.
