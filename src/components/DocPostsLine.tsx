import Link from "next/link";
import { createPostFromDoc } from "@/app/actions/posts";
import { derivePostStatus } from "@/lib/post-status";
import { postDateLabel, postDateTimeLabel, postPath } from "@/lib/post-path";
import { formatTimeUntil } from "@/lib/duration";
import styles from "./DocPostsLine.module.css";

export type DocPost = {
  id: string;
  slug: string;
  title: string;
  publishedAt: Date | null;
  publishEventId: string | null;
};

// PLAN.md §21i — the byline's post line on /doc/[slug], for a viewer who
// can edit the doc. A doc with no post gets the "Publish as blog post"
// button (§15d's doc-page entry point into post creation); a doc with posts
// gets one entry per post instead, " | "-separated, each leading to the
// place that post is best dealt with from:
//
// - published: "Published on <date>" linking to the live /yyyy/mm/dd/slug
//   URL, then "(configure)" to the post editor;
// - scheduled: "Scheduled for <time> (in …)" linking to the post editor,
//   since there is nowhere public to go yet;
// - draft: "(configure)" alone — a post row exists, so the button would
//   only make a second one, and the row needs somewhere to be found from.
//
// "as <post title>" is added when a post's title has diverged from the
// doc's (Post.title is its own column for exactly that reason).
//
// Every date here is UTC, by §21's rule for the byline's date on a post:
// postDateLabel/postDateTimeLabel slice the ISO string, so this renders once
// on the server with no zone to disagree with. The countdown is computed at
// request time — this page is dynamic, per viewer — and goes stale if the
// tab sits, which is what a reload is for.
//
// A Server Component (it renders a server-action form), handed to DocView
// inside the byline prop among siblings — so its element needs a key at
// the call site. CLAUDE.md's Gotchas has why.
export default function DocPostsLine({
  docId,
  docTitle,
  posts,
}: {
  docId: string;
  docTitle: string;
  posts: DocPost[];
}) {
  if (posts.length === 0) {
    // display: inline (DocPostsLine.module.css) so the form sits on the
    // byline's line; a <form> can't live inside a <p>, which is why the
    // byline is a <div>.
    return (
      <form action={createPostFromDoc.bind(null, docId)} className={styles.line}>
        <button type="submit">Publish as blog post</button>
      </form>
    );
  }

  return (
    <span className={styles.line}>
      {posts.map((post, i) => {
        const as = post.title.trim() !== docTitle.trim() ? ` as ${post.title}` : "";
        const status = derivePostStatus(post);
        const configure = (
          <>
            {" ("}
            <Link href={`/post/${post.id}/edit`}>configure</Link>
            {")"}
          </>
        );
        return (
          <span key={post.id}>
            {i > 0 && " | "}
            {status === "published" && post.publishedAt && (
              <>
                <Link href={postPath(post)} title={postDateTimeLabel(post.publishedAt)}>
                  Published{as} on {postDateLabel(post.publishedAt)}
                </Link>
                {configure}
              </>
            )}
            {status === "scheduled" && post.publishedAt && (
              <Link href={`/post/${post.id}/edit`}>
                Scheduled{as} for {postDateTimeLabel(post.publishedAt)} ({formatTimeUntil(post.publishedAt)})
              </Link>
            )}
            {status === "draft" && (
              <>
                Draft{as}
                {configure}
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}
