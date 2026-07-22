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

export function slugify(title: string, fallback = "post"): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}
