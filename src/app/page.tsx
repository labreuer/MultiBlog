import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { getPostEditStatus } from "@/lib/post-edit-status";
import { publishedPostWhere } from "@/lib/post-status";
import AuthorByline from "@/components/AuthorByline";
import PostEditBadge from "@/components/PostEditBadge";
import styles from "./page.module.css";

export const revalidate = 60;

export default async function Home() {
  const session = await auth();
  const posts = await prisma.post.findMany({
    where: publishedPostWhere(),
    orderBy: { publishedAt: "desc" },
    include: {
      publishRevision: { select: { title: true, doc: true } },
      authors: {
        orderBy: { bylineOrder: "asc" },
        include: { user: { select: { name: true, slug: true } } },
      },
      revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { createdAt: true } },
      collab: { select: { updatedAt: true } },
    },
  });

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", fontFamily: "sans-serif" }}>
      <main style={{ padding: "1rem" }}>
        {posts.length === 0 ? (
          <p>No posts published yet.</p>
        ) : (
          posts.map((post) => {
            const excerpt = post.publishRevision ? extractText(post.publishRevision.doc).slice(0, 200) : "";
            const editStatus = getPostEditStatus(session?.user, post);

            return (
              <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid #eee" }}>
                <h2 className={styles.postHeading}>
                  <Link href={`/${post.slug}`} className={styles.titleLink}>
                    {post.publishRevision?.title ?? post.title}
                  </Link>
                  {editStatus.canEdit && <PostEditBadge postId={post.id} hasPendingEdits={editStatus.hasPendingEdits} />}
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
