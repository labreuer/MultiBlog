import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import AuthorByline from "@/components/AuthorByline";

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
        include: {
          authors: {
            orderBy: { bylineOrder: "asc" },
            include: { user: { select: { name: true, slug: true } } },
          },
        },
      })
    : [];

  // Hobby-scale substring search over title + body text — no search index,
  // fine for the post counts this site is built for (§9, "small/hobby scale").
  const needle = query.toLowerCase();
  const results = posts
    .map((post) => ({ post, text: post.proseJson ? extractText(post.proseJson) : "" }))
    .filter(({ post, text }) => post.title.toLowerCase().includes(needle) || text.toLowerCase().includes(needle));

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
          <p style={{ color: "#666" }}>Enter a search term above.</p>
        ) : results.length === 0 ? (
          <p style={{ color: "#666" }}>
            No posts match &ldquo;{query}&rdquo;.
          </p>
        ) : (
          results.map(({ post, text }) => {
            const excerpt = text.slice(0, 200);

            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2>
                  <Link href={`/${post.slug}`}>{post.title}</Link>
                </h2>
                <p style={{ color: "#666", fontSize: "0.9rem" }}>
                  <AuthorByline authors={post.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name }))} />
                  {post.publishedAt?.toLocaleDateString()}
                </p>
                <p>
                  {excerpt}
                  {excerpt.length === 200 ? "…" : ""}
                </p>
              </article>
            );
          })
        )}
      </main>
    </div>
  );
}
