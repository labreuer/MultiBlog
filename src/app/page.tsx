import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import AuthorByline from "@/components/AuthorByline";
import styles from "./page.module.css";

export const revalidate = 60;

export default async function Home() {
  const posts = await prisma.post.findMany({
    where: publishedPostWhere(),
    orderBy: { publishedAt: "desc" },
    include: {
      authors: {
        orderBy: { bylineOrder: "asc" },
        include: { user: { select: { name: true, slug: true } } },
      },
    },
  });

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <main style={{ padding: "1rem" }}>
        {posts.length === 0 ? (
          <p>No posts published yet.</p>
        ) : (
          posts.map((post) => {
            const excerpt = post.proseJson ? extractText(post.proseJson).slice(0, 200) : "";

            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2 className={styles.postHeading}>
                  <Link href={`/${post.slug}`} className={styles.titleLink}>
                    {post.title}
                  </Link>
                </h2>
                <p style={{ color: "#666", fontSize: "0.9rem" }}>
                  <AuthorByline authors={post.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name }))} />
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
