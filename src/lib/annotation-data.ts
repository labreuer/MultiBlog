import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { collectMarkAttrValues, extractMarkedText } from "@/lib/tiptap-schema";

// PLAN.md §13c — the doc-side view-model, un-shared from comment-data.ts's
// ThreadWithComments (§12i's original decision) now that an annotation body
// is becoming its own collaborative document rather than a plain-text
// textarea: the two sides no longer have the same rendering problem, so
// they no longer share a type either. Structurally similar to
// ThreadWithComments today because Phase 0 changes no behavior, only which
// module owns it — later phases (bodyText/proseJson/status) diverge it
// further without touching the post side at all.

export type AnnotationComment = {
  id: string;
  parentAnnotationId: string | null;
  displayName: string;
  bodyText: string;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
};

export type AnnotationThread = {
  id: string;
  // Always null — a doc annotation has no stored absolute offset to sort by
  // (§12i); kept only so AnnotationList's quote-position sort mode has a
  // field to read (a no-op today, PLAN.md §12o's known gap).
  anchorFrom: number | null;
  // "" once the root annotation's mark is no longer in the document —
  // renders in the general-discussion bucket instead of under a quote
  // header (§12h: degrades, not detached — there's no frozen revision to
  // show a blockquote against). Every "" thread renders, not just the
  // first, unlike a post's single general thread.
  quotedText: string;
  // The thread's own color: whoever opened it (root.user.color) — shared by
  // every reply, same as the post side's per-thread color.
  color: string;
  comments: AnnotationComment[];
};

// Same shape getPostThreadsWithApprovedComments (comment-data.ts) returns,
// built very differently since there's no separate thread table: a root
// annotation (parentAnnotationId null) *is* the thread, and every reply —
// including a reply-of-a-reply — is grouped under it by walking
// parentAnnotationId pointers back to their root. No status filter:
// annotations are never moderated, so every row is eligible (deleted ones
// still fetched, so AnnotationNode can render "[deleted]" for one with live
// replies).
export async function getDocAnnotationsAsThreads(docId: string): Promise<AnnotationThread[]> {
  const [doc, annotations] = await Promise.all([
    prisma.doc.findUnique({ where: { id: docId }, select: { proseJson: true } }),
    prisma.annotation.findMany({
      where: { docId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { name: true, email: true, color: true } } },
    }),
  ]);

  const proseJson = doc?.proseJson as JSONContent | null;
  const markedIds = new Set(proseJson ? collectMarkAttrValues(proseJson, "annotation", "id") : []);

  const byId = new Map(annotations.map((a) => [a.id, a]));
  function rootIdOf(annotation: (typeof annotations)[number]): string {
    let current = annotation;
    const seen = new Set<string>();
    while (current.parentAnnotationId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentAnnotationId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  const byRoot = new Map<string, typeof annotations>();
  for (const annotation of annotations) {
    const rootId = rootIdOf(annotation);
    const members = byRoot.get(rootId) ?? [];
    members.push(annotation);
    byRoot.set(rootId, members);
  }

  const threads: AnnotationThread[] = [];
  for (const [rootId, members] of byRoot) {
    const root = byId.get(rootId);
    if (!root) continue;
    const quotedText = proseJson && markedIds.has(rootId) ? extractMarkedText(proseJson, "annotation", "id", rootId) : "";
    threads.push({
      id: rootId,
      anchorFrom: null,
      quotedText,
      color: root.user.color,
      comments: members.map((a) => ({
        id: a.id,
        parentAnnotationId: a.parentAnnotationId,
        displayName: a.user.name ?? a.user.email,
        bodyText: (a.body as { text?: string } | null)?.text ?? "",
        createdAt: a.createdAt.toISOString(),
        deletedByUserId: a.deletedByUserId,
        commenterUserId: a.userId,
      })),
    });
  }

  return threads;
}
