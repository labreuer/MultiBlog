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
  // The rich body, straight from the annotation's own ydoc cache (§13a) —
  // null only for a DRAFT that was created but never reached a store
  // debounce (e.g. abandoned mid-open), in which case bodyText/proseJson
  // are still their creation-time empty-paragraph values.
  proseJson: JSONContent | null;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
  // PLAN.md §12p/§13 — which ydoc_update this was posted against, stringified
  // for the client boundary (BigInt isn't serializable). Metadata only — see
  // the column's own comment in schema.prisma — not present until
  // postAnnotation writes it, so null for a DRAFT and for anything posted
  // before this column existed.
  ydocUpdateId: string | null;
};

export type AnnotationThread = {
  id: string;
  // PLAN.md §13o — the root's stored offsets, for a thread anchored from a
  // reading view; null for one anchored with a mark, which has no stored
  // offset at all (§12i) and has to be found in the live document instead.
  // A null pair is what tells every surface which mechanism to resolve
  // through. It also, incidentally, makes AnnotationList's quote-position
  // sort mode do something for the first time (§12o's known gap) — for
  // column-anchored threads, which is as far as a stored field can take it.
  anchorFrom: number | null;
  anchorTo: number | null;
  // The quoted passage, from whichever mechanism anchored it: the stored
  // column for a reading-view annotation, or the text under the mark for an
  // editor one.
  //
  // The two degrade differently, on purpose. A lost *mark* leaves nothing
  // behind — "" here, and the thread renders in the general-discussion
  // bucket (§12h: degraded, not detached, since there's no frozen revision
  // to show a blockquote against). A *stored* quote survives its own
  // detachment, because it was derived server-side against a state that is
  // still reconstructible (§13o), so the card keeps its blockquote and says
  // what it was about even once that text is gone — which is what a
  // DETACHED comment thread does on the post side. Every "" thread renders,
  // not just the first, unlike a post's single general thread.
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
// parentAnnotationId pointers back to their root. No moderation filter:
// annotations are never moderated, so every non-DRAFT row is eligible
// (deleted ones still fetched, so AnnotationNode can render "[deleted]" for
// one with live replies).
//
// PLAN.md §13d — a DRAFT annotation (still being composed, or saved
// "Keep private") is excluded outright, including from its own author:
// this is the thread list every doc reader sees, and a private note has no
// business appearing in it even for the person who wrote it. The one place
// an author *can* find their own drafts again is getOwnDraftAnnotations
// below, a deliberately separate, narrower query.
export async function getDocAnnotationsAsThreads(docId: string): Promise<AnnotationThread[]> {
  const [doc, annotations] = await Promise.all([
    prisma.doc.findUnique({ where: { id: docId }, select: { proseJson: true } }),
    prisma.annotation.findMany({
      where: { docId, status: { not: "DRAFT" } },
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
    // PLAN.md §13o — stored columns first, since a row that has them was
    // never marked and looking for its mark would always come up empty. The
    // mark branch is unchanged, and is still read against Doc.proseJson: a
    // store-debounce snapshot is fine for deciding *whether* to draw a quote
    // header, and is never what decides where the card goes (§18b).
    const columnAnchored = root.anchorFrom !== null && root.anchorTo !== null && root.quotedText !== "";
    const quotedText = columnAnchored
      ? root.quotedText
      : proseJson && markedIds.has(rootId)
        ? extractMarkedText(proseJson, "annotation", "id", rootId)
        : "";
    threads.push({
      id: rootId,
      anchorFrom: columnAnchored ? root.anchorFrom : null,
      anchorTo: columnAnchored ? root.anchorTo : null,
      quotedText,
      color: root.user.color,
      comments: members.map((a) => ({
        id: a.id,
        parentAnnotationId: a.parentAnnotationId,
        displayName: a.user.name ?? a.user.email,
        bodyText: a.bodyText,
        proseJson: a.proseJson as JSONContent | null,
        createdAt: a.createdAt.toISOString(),
        deletedByUserId: a.deletedByUserId,
        commenterUserId: a.userId,
        ydocUpdateId: a.ydocUpdateId?.toString() ?? null,
      })),
    });
  }

  return threads;
}

export type OwnDraft = {
  id: string;
  bodyText: string;
  createdAt: string;
};

// PLAN.md §13d — "Keep private" leaves a DRAFT sitting in the DB rather
// than discarding it (Cancel's job); this is the *only* thing that makes
// that persistence worth anything, since getDocAnnotationsAsThreads
// excludes DRAFT unconditionally. Scoped to docId + the caller's own
// userId — never call this with anyone else's id (§13a: DRAFT visibility
// is owner-only, with no admin override, and this query is the one place
// that rule actually has to be enforced in code rather than by a mark
// simply not existing yet).
export async function getOwnDraftAnnotations(docId: string, userId: string): Promise<OwnDraft[]> {
  const drafts = await prisma.annotation.findMany({
    where: { docId, userId, status: "DRAFT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, bodyText: true, createdAt: true },
  });
  return drafts.map((d) => ({ id: d.id, bodyText: d.bodyText, createdAt: d.createdAt.toISOString() }));
}
