import Link from "next/link";
import { postPagePath } from "@/lib/post-pages";
import styles from "./PostPager.module.css";

// docs/BLOG.md — the line between the blog's listing pages: older on the
// left, newer on the right, the timeline PostNeighbours runs the same way.
// `rel` follows the pages as a series, which runs from newest to oldest, so
// the older page is `next`.
//
// A Server Component reading no session: `/` and `/page/N` are ISR.

export default function PostPager({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Pages of posts" className={styles.pager}>
      <span className={styles.older}>
        {page < pageCount && (
          <Link href={postPagePath(page + 1)} rel="next">
            ← Older posts
          </Link>
        )}
      </span>
      <span className={styles.position}>
        Page {page} of {pageCount}
      </span>
      <span className={styles.newer}>
        {page > 1 && (
          <Link href={postPagePath(page - 1)} rel="prev">
            Newer posts →
          </Link>
        )}
      </span>
    </nav>
  );
}
