// PLAN.md §21 — the single place the post URL shape is written down, the
// same "one module owns the URL" pattern as src/lib/avatar-url.ts (§17n).
// A published post lives at /yyyy/mm/dd/slug; every link, revalidation and
// byline goes through here rather than knowing that.
//
// Browser-safe on purpose (PostsTable is a client component): no Prisma, no
// next/cache. The revalidation half is src/lib/revalidate-post.ts.

export type PostDateParts = { year: string; month: string; day: string };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The date segments of a post's URL — **UTC, always** (§21b). `publishedAt`
 * is stored in UTC; deriving the segments in server-local time would let a
 * deploy to a box in another timezone silently move the canonical URL of
 * every post published near midnight, and let `generateStaticParams` (build
 * machine) disagree with the request handler (runtime) about where a post
 * lives.
 */
export function postDateParts(publishedAt: Date): PostDateParts {
  return {
    year: String(publishedAt.getUTCFullYear()).padStart(4, "0"),
    month: pad2(publishedAt.getUTCMonth() + 1),
    day: pad2(publishedAt.getUTCDate()),
  };
}

/** `/yyyy/mm/dd` — what SlugManager gets as the post's `urlPrefix`. */
export function postDatePath(publishedAt: Date): string {
  const { year, month, day } = postDateParts(publishedAt);
  return `/${year}/${month}/${day}`;
}

/**
 * `/yyyy/mm/dd/slug`. `publishedAt` is typed nullable because that is how a
 * Post row arrives from Prisma; a null here is a draft, which has no public
 * page at all, so it throws rather than inventing a path. Rows that came
 * through `publishedPostWhere()` never hit that branch.
 */
export function postPath(post: { slug: string; publishedAt: Date | null }): string {
  if (!post.publishedAt) {
    throw new Error(`Post "${post.slug}" has no publishedAt, so it has no public path.`);
  }
  return `${postDatePath(post.publishedAt)}/${post.slug}`;
}

/**
 * The byline's date, read from the same parts as the URL so the two cannot
 * disagree (§21b). A post published at 21:00 EDT is the 5th in UTC: the URL
 * says so, and so does this.
 */
export function postDateLabel(publishedAt: Date): string {
  const { year, month, day } = postDateParts(publishedAt);
  return `${year}-${month}-${day}`;
}

const YEAR_RE = /^\d{4}$/;
const TWO_DIGITS_RE = /^\d{2}$/;

/**
 * The route's shape gate. `/[year]/[month]/[day]/[slug]` matches *any*
 * four-segment path nothing static claims — `/a/b/c/d` included — so the
 * page runs this before touching the database (§21a). Accepts only a real
 * calendar date written exactly as `postDateParts` writes it: four digits,
 * two, two, zero-padded.
 */
export function parsePostDateSegments(year: string, month: string, day: string): PostDateParts | null {
  if (!YEAR_RE.test(year) || !TWO_DIGITS_RE.test(month) || !TWO_DIGITS_RE.test(day)) {
    return null;
  }
  // Date.UTC rolls an out-of-range day forward rather than refusing it —
  // 2026-02-30 becomes 2026-03-02 — so the check is whether the parts survive
  // a round trip. (Years 0–99 map to 1900–1999 inside Date.UTC and so fail
  // the round trip too, which is the right answer for a URL segment.)
  const parts = postDateParts(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
  return parts.year === year && parts.month === month && parts.day === day ? parts : null;
}

/**
 * The full timestamp for a publish date's tooltip — `2026-09-15 21:03:47 UTC`
 * — in the same zone as the URL and the byline, so the three never disagree
 * about which day a post belongs to. Pure ISO slicing, no `Intl`, for the
 * same reason `LocalTime`'s fallback avoids it: this is rendered once on the
 * server into ISR output and must not depend on the box's locale.
 */
export function postDateTimeLabel(publishedAt: Date): string {
  const iso = publishedAt.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * The three archive pages a published post is listed on (§21h): `/yyyy`,
 * `/yyyy/mm` and `/yyyy/mm/dd`. Whatever changes which posts a date lists,
 * or what a listing shows for one, revalidates all three.
 */
export function postDateArchivePaths(publishedAt: Date): string[] {
  const { year, month, day } = postDateParts(publishedAt);
  return [`/${year}`, `/${year}/${month}`, `/${year}/${month}/${day}`];
}

export type PostDateRange = {
  /** Inclusive, UTC. */
  start: Date;
  /** Exclusive, UTC. */
  end: Date;
  /** `2026`, `2026-09` or `2026-09-15` — the same shape as `postDateLabel`. */
  label: string;
  /** `/2026`, `/2026/09` or `/2026/09/15`. */
  path: string;
};

/**
 * The archive routes' shape gate (§21h), the prefix-length sibling of
 * `parsePostDateSegments`. `/[year]` matches *every* one-segment path nothing
 * static claims — `/tag`, `/doc`, `/favicon.ico` — and its children every
 * two- and three-segment one, so each page runs this before touching the
 * database and 404s on null. Same rule as the full date: four digits, then
 * zero-padded two-digit month and day, each a real calendar value, written
 * exactly as `postDateParts` writes it.
 *
 * Returns the half-open UTC range the page queries by, so a February prefix
 * is `[Feb 1, Mar 1)` and a year is `[Jan 1, Jan 1 next year)` — the range
 * arithmetic lives here rather than in three route files.
 */
export function parsePostDatePrefix(year: string, month?: string, day?: string): PostDateRange | null {
  if (!YEAR_RE.test(year)) return null;
  if (month !== undefined && !TWO_DIGITS_RE.test(month)) return null;
  if (day !== undefined && (month === undefined || !TWO_DIGITS_RE.test(day))) return null;

  const y = Number(year);
  const m = month === undefined ? 1 : Number(month);
  const d = day === undefined ? 1 : Number(day);
  // Same round trip as parsePostDateSegments: Date.UTC rolls an out-of-range
  // month or day forward rather than refusing it, and maps years 0–99 into
  // the 1900s, so the check is whether the parts come back unchanged.
  const start = new Date(Date.UTC(y, m - 1, d));
  const parts = postDateParts(start);
  if (parts.year !== year || (month !== undefined && parts.month !== month) || (day !== undefined && parts.day !== day)) {
    return null;
  }

  if (day !== undefined) {
    return {
      start,
      end: new Date(Date.UTC(y, m - 1, d + 1)),
      label: `${year}-${month}-${day}`,
      path: `/${year}/${month}/${day}`,
    };
  }
  if (month !== undefined) {
    return { start, end: new Date(Date.UTC(y, m, 1)), label: `${year}-${month}`, path: `/${year}/${month}` };
  }
  return { start, end: new Date(Date.UTC(y + 1, 0, 1)), label: year, path: `/${year}` };
}
