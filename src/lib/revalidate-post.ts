import { revalidatePath } from "next/cache";
import { postPath } from "@/lib/post-path";

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
