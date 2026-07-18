import Link from "next/link";

type Author = { userId: string; name: string | null };

// Shared by every place a post's byline is rendered (home, search, article
// pages) so the "By A, B — " formatting and author-page links can't drift.
export default function AuthorByline({ authors }: { authors: Author[] }) {
  const named = authors.filter((a): a is Author & { name: string } => !!a.name);
  if (named.length === 0) {
    return null;
  }

  return (
    <>
      By{" "}
      {named.map((author, i) => (
        <span key={author.userId}>
          {i > 0 && ", "}
          <Link href={`/authors/${author.userId}`}>{author.name}</Link>
        </span>
      ))}
      {" — "}
    </>
  );
}
