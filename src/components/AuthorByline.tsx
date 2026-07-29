import Link from "next/link";

type Author = { userId: string; slug: string; name: string | null };

type Props = {
  authors: Author[];
  // Off for the doc reading view's byline, built inline in
  // app/doc/[slug]/page.tsx — a doc has no "By " convention of its own, just
  // the same name-list/link formatting a post's byline already has (there,
  // the names are followed by the doc's updatedAt rather than a publish
  // date, since a doc never publishes — PLAN.md §12n).
  showPrefix?: boolean;
};

// Shared by every place a post's byline is rendered (home, search, article
// pages) so the "By A, B — " formatting and author-page links can't drift.
export default function AuthorByline({ authors, showPrefix = true }: Props) {
  const named = authors.filter((a): a is Author & { name: string } => !!a.name);
  if (named.length === 0) {
    return null;
  }

  return (
    <>
      {showPrefix && "By "}
      {named.map((author, i) => (
        <span key={author.userId}>
          {i > 0 && ", "}
          <Link href={`/authors/${author.slug}`}>{author.name}</Link>
        </span>
      ))}
      {" — "}
    </>
  );
}
