import Link from "next/link";
import { postDateLabel, postDatePath, postDateTimeLabel } from "@/lib/post-path";
import styles from "./PostDate.module.css";

// A post's publish date wherever a byline shows one: the `yyyy-mm-dd` label,
// linking to that day's archive (PLAN.md §21h), with the full timestamp as a
// native tooltip. Everything here is UTC by construction — the label, the
// link's path and the tooltip all come from src/lib/post-path.ts, so a post
// published at 21:00 EDT says the 5th, links to the 5th and shows
// `… UTC` in the tooltip to say why. That is what keeps this a Server
// Component: nothing reads the reader's zone, so it renders once into ISR
// output with no hydration to get wrong (CLAUDE.md's toLocale* gotcha).
//
// Shared by every listing and the post page itself, the same reason
// AuthorByline exists — so the label/link/tooltip trio can't drift apart.
export default function PostDate({ publishedAt }: { publishedAt: Date }) {
  return (
    <Link href={postDatePath(publishedAt)} title={postDateTimeLabel(publishedAt)} className={styles.date}>
      <time dateTime={publishedAt.toISOString()}>{postDateLabel(publishedAt)}</time>
    </Link>
  );
}
