import { recreateTransform } from "@fellow/prosemirror-recreate-transform";
import { pmSchema } from "./tiptap-schema";
import { prisma } from "./prisma";

// Remaps every ACTIVE *or DETACHED* quote-anchored thread on a post forward
// from whatever revision it's currently anchored to, onto the revision that
// was just published — the "surviving a new revision" mechanism from
// PLAN.md §5. Threads are grouped by their current anchoredRevisionId so a
// post whose threads lag behind by several publishes (or the remap job
// hasn't run since this feature shipped) still only costs one document diff
// per distinct source revision, not one per thread.
//
// DETACHED is included deliberately, not just ACTIVE: a DETACHED thread stays
// frozen at the last revision it was valid against (never touched again while
// it remains detached, below), so it's still grouped and re-diffed by that
// same frozen revision on every later publish. If the article's text at that
// anchor now matches the thread's quotedText again — most directly, restoring
// that exact revision and publishing it, PLAN.md §10 — the thread reattaches.
// Before this, DETACHED was a terminal state: excluded from the query
// entirely, so nothing ever gave a detached thread a second look, no matter
// what a later revision said.
export async function remapThreadsToRevision(postId: string, newRevisionId: string): Promise<void> {
  const threads = await prisma.commentThread.findMany({
    where: { postId, status: { in: ["ACTIVE", "DETACHED"] }, quotedText: { not: "" } },
  });

  const byRevision = new Map<string, typeof threads>();
  for (const thread of threads) {
    if (thread.anchoredRevisionId === newRevisionId) continue;
    const group = byRevision.get(thread.anchoredRevisionId);
    if (group) group.push(thread);
    else byRevision.set(thread.anchoredRevisionId, [thread]);
  }
  if (byRevision.size === 0) return;

  const newRevision = await prisma.revision.findUniqueOrThrow({ where: { id: newRevisionId } });
  const newNode = pmSchema.nodeFromJSON(newRevision.doc as object);

  for (const [oldRevisionId, group] of byRevision) {
    const oldRevision = await prisma.revision.findUnique({ where: { id: oldRevisionId } });
    if (!oldRevision) continue;

    const oldNode = pmSchema.nodeFromJSON(oldRevision.doc as object);
    const { mapping } = recreateTransform(oldNode, newNode);

    for (const thread of group) {
      // Bias each end away from the range (start forward, end backward) so
      // text inserted exactly at a boundary doesn't get pulled into what's
      // supposed to be a stable quote — same convention ProseMirror itself
      // uses for mapping decorations/marks across a transform.
      const mappedFrom = mapping.map(thread.anchorFrom, 1);
      const mappedTo = mapping.map(thread.anchorTo, -1);
      const survived =
        mappedTo > mappedFrom &&
        newNode.textBetween(mappedFrom, mappedTo, " ").trim() === thread.quotedText.trim();

      // A DETACHED thread that's still not found: nothing to write. Its
      // anchor stays frozen at oldRevisionId exactly as it already was — a
      // write here would be a no-op on every field, repeated on every future
      // publish for as long as the thread stays detached.
      if (!survived && thread.status === "DETACHED") continue;

      await prisma.commentThread.update({
        where: { id: thread.id },
        data: survived
          ? { anchorFrom: mappedFrom, anchorTo: mappedTo, anchoredRevisionId: newRevisionId, status: "ACTIVE" }
          : { status: "DETACHED" },
      });
    }
  }
}
