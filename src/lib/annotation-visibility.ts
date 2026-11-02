// Whether an annotation thread still has anything to show, for every surface
// that draws one. Not a client module, so the doc page's server component can
// filter with it too: a function imported from a "use client" file is only a
// reference on the server, not something it can call.

type ThreadNode = { deletedByUserId: string | null; replies: readonly ThreadNode[] };

// Whether any annotation anywhere below this one (not just direct replies)
// is still live — a deleted annotation with no live descendants collapses
// entirely rather than leaving a "[deleted]" placeholder with nothing under it.
export function hasNonDeletedDescendant(annotation: ThreadNode): boolean {
  return annotation.replies.some((reply) => reply.deletedByUserId === null || hasNonDeletedDescendant(reply));
}

/**
 * Whether a thread still has anything to show.
 *
 * Deletion is a *soft* delete, and a deleted root whose replies survive is
 * still a live conversation — so this is `hasNonDeletedDescendant`, not a plain
 * `deletedByUserId === null`. Every surface showing a thread has to agree on
 * it, or deleting an annotation removes its card and leaves the rest behind:
 * "I deleted it but it's still there".
 *
 * On a PDF that is four surfaces: the card, its page badge, the highlight drawn
 * on the page, and the tick on the right-hand strip. On a doc it is the card
 * and, for an annotation written from a reading view, its highlight: that one
 * is anchored by stored offsets and drawn as a decoration
 * (annotation-highlight-extension.ts), so there is no mark for the delete to
 * remove and the anchor list is the only thing that can let it go. A mark-
 * anchored annotation's highlight goes with its mark.
 */
export function entryHasVisibleContent(entry: { root: ThreadNode }): boolean {
  return entry.root.deletedByUserId === null || hasNonDeletedDescendant(entry.root);
}
