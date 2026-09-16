import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import PostListing, { postListingInclude } from "@/components/PostListing";

// No gate to repeat, unlike the doc and post surfaces — the results are
// publishedPostWhere() only, and the query came from the viewer's own URL.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  return { title: query ? `Search: ${query}` : "Search" };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  const posts = query
    ? await prisma.post.findMany({
        where: publishedPostWhere(),
        orderBy: { publishedAt: "desc" },
        include: postListingInclude,
      })
    : [];

  // Hobby-scale substring search over title + body text — no search index,
  // fine for the post counts this site is built for (§9, "small/hobby scale").
  const needle = query.toLowerCase();
  const results = posts.filter(
    (post) =>
      post.title.toLowerCase().includes(needle) ||
      (post.proseJson ? extractText(post.proseJson).toLowerCase().includes(needle) : false),
  );

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <main style={{ padding: "1rem" }}>
        <form action="/search" style={{ marginBottom: "1.5rem" }}>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search posts…"
            autoFocus
            style={{ padding: "0.5rem", width: "100%", maxWidth: 400, fontSize: "1rem" }}
          />
        </form>

        {!query ? (
          <p style={{ color: "var(--text-secondary)" }}>Enter a search term above.</p>
        ) : (
          <PostListing posts={results} emptyMessage={`No posts match “${query}”.`} />
        )}
      </main>
    </div>
  );
}
