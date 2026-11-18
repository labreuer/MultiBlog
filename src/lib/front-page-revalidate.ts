import { revalidatePath } from "next/cache";
import { prismaIncludingDeleted } from "@/lib/prisma";

// docs/WIKI.md "The front page" — the server-only half of src/lib/front-page.ts,
// as revalidate-post.ts is post-path.ts's: `/` is ISR-cached for 60 seconds
// (docs/BLOG.md §8), so a write that can put a commons page on the landing
// page or take it off revalidates `/` itself, or a page lowered from PUBLIC
// stays there until the cache expires. The functions in src/lib/ revalidate
// nothing; their wrappers (the server actions, MCP's `manage`) call these.

/** Revalidates `/`: for a write already known to touch a commons page, such as a create, a fork or a move into the commons, or a move out of it. */
export function revalidateFrontPage(): void {
  revalidatePath("/");
}

/**
 * Revalidates `/` when `docId` is a commons page as it is now, deleted or
 * not: after a visibility change, a delete or restore, or a rename within
 * the commons. Any commons page, not only the one at the front page's
 * address, since a rename can move a page onto that address or off it, and
 * the fold that would tell is the database's.
 */
export async function revalidateFrontPageFor(docId: string): Promise<void> {
  const doc = await prismaIncludingDeleted.doc.findUnique({ where: { id: docId }, select: { wikiName: true, wikiOwnerUserId: true } });
  if (doc && doc.wikiName !== null && doc.wikiOwnerUserId === null) revalidateFrontPage();
}
