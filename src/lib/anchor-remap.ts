import { recreateTransform } from "@fellow/prosemirror-recreate-transform";
import { pmSchema } from "./tiptap-schema";
import { prisma } from "./prisma";

// Remaps every ACTIVE *or DETACHED* quote-anchored thread on a post forward
// from whatever publication event it's currently anchored to, onto the event
// that was just published — the "surviving a new revision" mechanism from
// PLAN.md §5, now diffing PostPublicationEvent.proseJson pairs instead of
// Revision.doc pairs (§15). Threads are grouped by their current
// anchoredEventId so a post whose threads lag behind by several publishes
// still only costs one document diff per distinct source event, not one per
// thread.
//
// DETACHED is included deliberately, not just ACTIVE: a DETACHED thread stays
// frozen at the last event it was valid against (never touched again while it
// remains detached, below), so it's still grouped and re-diffed by that same
// frozen event on every later publish. If the article's text at that anchor
// now matches the thread's quotedText again — most directly, scrubbing back
// to and republishing the doc state a restore used to reach, PLAN.md §15 —
// the thread reattaches. Before this, DETACHED was a terminal state: excluded
// from the query entirely, so nothing ever gave a detached thread a second
// look, no matter what a later publish said.
export async function remapThreadsToEvent(postId: string, newEventId: string): Promise<void> {
  const threads = await prisma.commentThread.findMany({
    where: { postId, status: { in: ["ACTIVE", "DETACHED"] }, quotedText: { not: "" } },
  });

  const byEvent = new Map<string, typeof threads>();
  for (const thread of threads) {
    if (thread.anchoredEventId === newEventId) continue;
    const group = byEvent.get(thread.anchoredEventId);
    if (group) group.push(thread);
    else byEvent.set(thread.anchoredEventId, [thread]);
  }
  if (byEvent.size === 0) return;

  const newEvent = await prisma.postPublicationEvent.findUniqueOrThrow({ where: { id: newEventId } });
  const newNode = pmSchema.nodeFromJSON((newEvent.proseJson ?? { type: "doc", content: [] }) as object);

  for (const [oldEventId, group] of byEvent) {
    const oldEvent = await prisma.postPublicationEvent.findUnique({ where: { id: oldEventId } });
    // An event with no proseJson (UNPUBLISHED/SCHEDULE_CANCELED) never
    // becomes a thread's anchor — see submitComment, which anchors to
    // post.publishEventId, always a PUBLISHED/SCHEDULED row — so this only
    // guards a row that's since been deleted out from under the thread.
    if (!oldEvent || !oldEvent.proseJson) continue;

    const oldNode = pmSchema.nodeFromJSON(oldEvent.proseJson as object);
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
      // anchor stays frozen at oldEventId exactly as it already was — a
      // write here would be a no-op on every field, repeated on every future
      // publish for as long as the thread stays detached.
      if (!survived && thread.status === "DETACHED") continue;

      await prisma.commentThread.update({
        where: { id: thread.id },
        data: survived
          ? { anchorFrom: mappedFrom, anchorTo: mappedTo, anchoredEventId: newEventId, status: "ACTIVE" }
          : { status: "DETACHED" },
      });
    }
  }
}
