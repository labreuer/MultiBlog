// Top-level route segments under src/app/ — a slug matching one of these
// would be shadowed by the static route and never resolve to /[slug]. Only
// relevant to post-slug.ts today: author slugs live under the nested
// /authors/[slug], which has no sibling static routes to collide with.
export const RESERVED_SLUGS = new Set([
  "api",
  "authors",
  "dashboard",
  "forgot-password",
  "posts",
  "reset-password",
  "rss.xml",
  "search",
  "sign-in",
  "sign-up",
  "site-settings",
  "users",
]);

// revertPostSlug/revertUserSlug use this: if the slug being abandoned by a
// revert only went live less than this long ago, nothing external could
// plausibly have linked to it yet, so it's discarded outright instead of
// getting its own PostSlugHistory/UserSlugHistory row. Exported (rather than
// living only in post-slug.ts/user-slug.ts) so SlugManager.tsx's optimistic
// client-side update can apply the same rule without waiting on the server
// round-trip.
export const REVERT_DISCARD_WINDOW_MS = 60 * 60 * 1000;

export function slugify(title: string, fallback = "post"): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}
