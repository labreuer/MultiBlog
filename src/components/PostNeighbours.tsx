import Link from "next/link";
import { findPostNeighbours } from "@/lib/post-neighbours";
import { postPath } from "@/lib/post-path";
import styles from "./PostNeighbours.module.css";

// docs/BLOG.md — a post's older and newer neighbours, at the end of the post
// and before its comments: older on the left, newer on the right, as
// PostPager runs. A side with no post is left empty rather than closed up:
// the stylesheet places "Newer" in the right-hand column whether or not
// "Older" is there.
//
// A Server Component reading no session, as everything on the post page must
// (docs/BLOG.md §2), so the page keeps generateStaticParams and `revalidate`.

export default async function PostNeighbours({ post }: { post: { id: string; publishedAt: Date } }) {
  const { older, newer } = await findPostNeighbours(post);
  if (!older && !newer) return null;
  return (
    <nav aria-label="Older and newer posts" className={styles.neighbours}>
      {older && (
        <Link href={postPath(older)} className={styles.older}>
          <span className={styles.label}>← Older</span>
          <span className={styles.title}>{older.title}</span>
        </Link>
      )}
      {newer && (
        <Link href={postPath(newer)} className={styles.newer}>
          <span className={styles.label}>Newer →</span>
          <span className={styles.title}>{newer.title}</span>
        </Link>
      )}
    </nav>
  );
}
