import { revalidatePath } from "next/cache";
import { postDateArchivePaths, postPath } from "@/lib/post-path";

// The server-only half of src/lib/post-path.ts: every action that changes
// what a published post's page shows calls this instead of spelling the path
// out (PLAN.md §21e). A draft has no page to invalidate, so a null
// publishedAt is a no-op rather than an error here — an action can touch a
// post at any point in its life.
export function revalidatePostPage(post: { slug: string; publishedAt: Date | null }): void {
  if (post.publishedAt) {
    revalidatePath(postPath(post));
  }
}

// The three date archive pages a post is listed on (§21h) — `/yyyy`,
// `/yyyy/mm`, `/yyyy/mm/dd`. Separate from revalidatePostPage on purpose:
// a comment landing on a post changes the post's page and nothing a listing
// shows, so the comment actions call only the one above. Publish, unpublish
// and a slug change call both.
export function revalidatePostArchives(post: { publishedAt: Date | null }): void {
  if (post.publishedAt) {
    for (const path of postDateArchivePaths(post.publishedAt)) {
      revalidatePath(path);
    }
  }
}
