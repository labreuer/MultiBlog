import Image from "next/image";
import { renderToReactElement } from "@tiptap/static-renderer";
import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { getFrontPagePreamble } from "@/lib/front-page";
import { SITE_BANNER, SITE_BANNER_ASPECT, SITE_BANNER_ALT } from "@/lib/site-banner";
import { contentExtensions } from "@/lib/tiptap-schema";
import PostListing, { postListingInclude } from "@/components/PostListing";
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
      include: postListingInclude,
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
          <PostListing posts={posts} emptyMessage="No posts published yet." />
        </main>
        <ContributorList />
      </div>
    </div>
  );
}
