import { revalidatePath } from "next/cache";
import { postDateArchivePaths, postPath } from "@/lib/post-path";
import { findPostNeighbours } from "@/lib/post-neighbours";

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

// The blog's listing pages (docs/BLOG.md): `/`, and every `/page/N` as one
// route pattern, since adding or removing one post shifts every page after it.
export function revalidatePostListPages(): void {
  revalidatePath("/");
  revalidatePath("/page/[n]", "page");
}

// The pages of the posts on either side of this one, whose Older and Newer
// links name it (docs/BLOG.md). findPostNeighbours leaves the post itself
// out, so this is right before or after a change to it: called after an
// unpublish, it finds the two posts that linked to this one.
export async function revalidatePostNeighbours(post: { id: string; publishedAt: Date | null }): Promise<void> {
  if (!post.publishedAt) return;
  const { older, newer } = await findPostNeighbours({ id: post.id, publishedAt: post.publishedAt });
  for (const neighbour of [older, newer]) {
    if (neighbour) revalidatePostPage(neighbour);
  }
}
