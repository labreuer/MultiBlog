// There is deliberately no reserved-slug list here any more. One existed
// while posts lived at the top-level /[slug], where a post slugged `posts` or
// `api` would have been shadowed by the static route; PLAN.md §21 moved posts
// to /yyyy/mm/dd/slug, and every other slugged thing (docs, files, tags,
// authors) already lived one level down with no sibling static routes to
// collide with. A slug may now legitimately be `docs`.

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
