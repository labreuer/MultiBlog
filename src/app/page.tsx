import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import SiteHeader from "@/components/SiteHeader";

export const revalidate = 60;

export default async function Home() {
  const posts = await prisma.post.findMany({
    where: { status: "PUBLISHED", currentRevisionId: { not: null } },
    orderBy: { publishedAt: "desc" },
    include: {
      currentRevision: { select: { title: true, doc: true } },
      authors: {
        orderBy: { bylineOrder: "asc" },
        include: { user: { select: { name: true } } },
      },
    },
  });

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <SiteHeader />
      <main style={{ padding: "1rem" }}>
        {posts.length === 0 ? (
          <p>No posts published yet.</p>
        ) : (
          posts.map((post) => {
            const byline = post.authors
              .map((a) => a.user.name)
              .filter(Boolean)
              .join(", ");
            const excerpt = post.currentRevision ? extractText(post.currentRevision.doc).slice(0, 200) : "";

            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2>
                  <Link href={`/${post.slug}`}>{post.currentRevision?.title ?? post.title}</Link>
                </h2>
                <p style={{ color: "#666", fontSize: "0.9rem" }}>
                  {byline && `By ${byline} — `}
                  {post.publishedAt?.toLocaleDateString()}
                </p>
                <p>{excerpt}{excerpt.length === 200 ? "…" : ""}</p>
              </article>
            );
          })
        )}
      </main>
    </div>
  );
}
