import Link from "next/link";
import Image from "next/image";
import { renderToReactElement } from "@tiptap/static-renderer";
import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";
import { publishedPostWhere } from "@/lib/post-status";
import { getFrontPagePreamble } from "@/lib/front-page";
import { SITE_BANNER, SITE_BANNER_ASPECT, SITE_BANNER_ALT } from "@/lib/site-banner";
import { contentExtensions } from "@/lib/tiptap-schema";
import AuthorByline from "@/components/AuthorByline";
import ContributorList from "@/components/ContributorList";
import proseStyles from "@/styles/prose.module.css";
import styles from "./page.module.css";

export const revalidate = 60;

// PLAN.md §17 — this route (and everything it renders, including
// ContributorList and the preamble) must never call auth()/cookies()/
// headers(): that's what keeps `revalidate = 60` a real shared ISR cache
// rather than a no-op (CACHING.md's 2026-07-20/23 entries), and §15's
// removal of PostEditBadge is what made that true again.
export default async function Home() {
  const [posts, preamble] = await Promise.all([
    prisma.post.findMany({
      where: publishedPostWhere(),
      orderBy: { publishedAt: "desc" },
      take: 10,
      include: {
        authors: {
          orderBy: { bylineOrder: "asc" },
          include: { user: { select: { name: true, slug: true } } },
        },
      },
    }),
    getFrontPagePreamble(),
  ]);

  return (
    <div>
      {SITE_BANNER && (
        <div className={styles.banner} style={{ aspectRatio: SITE_BANNER_ASPECT }}>
          <Image src={SITE_BANNER} alt={SITE_BANNER_ALT} fill priority className={styles.bannerImage} />
        </div>
      )}
      <div className={styles.layout}>
        <main>
          {preamble && (
            <div className={`${proseStyles.prose} ${styles.preamble}`}>{renderToReactElement({ content: preamble, extensions: contentExtensions })}</div>
          )}
          {posts.length === 0 ? (
            <p>No posts published yet.</p>
          ) : (
            posts.map((post) => {
              const excerpt = post.proseJson ? extractText(post.proseJson).slice(0, 200) : "";

              return (
                <article key={post.id} style={{ padding: "1.5rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                  <h2 className={styles.postHeading}>
                    <Link href={`/${post.slug}`} className={styles.titleLink}>
                      {post.title}
                    </Link>
                  </h2>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
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
        <ContributorList />
      </div>
    </div>
  );
}
