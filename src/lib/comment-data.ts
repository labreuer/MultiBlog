import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import { pmSchema, collectMarkAttrValues, extractMarkedText } from "@/lib/tiptap-schema";
import { colorForSeed } from "@/lib/author-colors";
import type { ThreadStatus } from "@/generated/prisma/enums";

// PLAN.md §12i — threads through CommentSection/CommentForm/CommentNode/
// CommentEntryList so the same components render both a post's
// CommentThread/Comment rows and a doc's Annotation rows. `id` is a postId
// or a docId depending on `kind`; the components never need to know more
// than that to route a submission/deletion to the right server action.
export type CommentTarget = { kind: "post" | "doc"; id: string };

export type ThreadComment = {
  id: string;
  parentCommentId: string | null;
  displayName: string;
  bodyText: string;
  createdAt: string;
  deletedByUserId: string | null;
  commenterUserId: string | null;
};

export type ThreadWithComments = {
  id: string;
  // Nullable because a doc annotation has no stable absolute offset to sort
  // by (§12i) — every annotation-sourced thread carries null here, which
  // CommentEntryList already treats as "sorts last" under quote-position
  // mode (the same fallback a post's own general thread already uses).
  anchorFrom: number | null;
  anchorTo: number | null;
  // "" means "renders in the general-discussion bucket, no QuoteThreadHeader"
  // — the same signal a post's own unanchored thread already uses, now also
  // covering a doc annotation whose mark is no longer in the document
  // (§12h: it degrades into the general discussion, not a detached-with-
  // blockquote state — there's nothing stored to show a blockquote for
  // once the mark's gone). CommentSection renders *every* thread with ""
  // here, not just the first — see its own comment for why that matters.
  quotedText: string;
  // Always ACTIVE for an annotation-sourced thread: docs never use DETACHED
  // (see quotedText above) or RESOLVED (nothing currently renders it
  // differently from ACTIVE on the post side either).
  status: ThreadStatus;
  // Null for a doc annotation — there is no frozen revision to fetch
  // surrounding context from (§12h/§12m defer that); getDetachedThreadContext
  // is simply never called for a null value.
  anchoredRevisionId: string | null;
  comments: ThreadComment[];
  // The thread's own color, not any one comment's — shared by every reply
  // in the thread (the highlight/bubble/arrow are per-thread UI, not
  // per-comment). Taken from whoever opened the thread: a signed-in
  // commenter's real User.color, or a stable seeded color for anonymous
  // ones so unrelated threads still read as visually distinct.
  color: string;
};

const CONTEXT_PADDING = 80;

// For a detached thread, pulls a snippet of surrounding text from the
// revision the quote was last known to be valid against, so a reader can
// still see where it used to sit even though it's gone from the current
// version (PLAN.md §5, "what the reader sees").
export async function getDetachedThreadContext(
  anchoredRevisionId: string,
  anchorFrom: number,
  anchorTo: number,
): Promise<string | null> {
  const revision = await prisma.revision.findUnique({ where: { id: anchoredRevisionId } });
  if (!revision) return null;

  const node = pmSchema.nodeFromJSON(revision.doc as object);
  const size = node.content.size;
  const from = Math.max(0, anchorFrom - CONTEXT_PADDING);
  const to = Math.min(size, anchorTo + CONTEXT_PADDING);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < size ? "…" : "";
  return prefix + node.textBetween(from, to, " ") + suffix;
}

// Threads only surface once they have at least one APPROVED comment — a
// thread whose sole comment was rejected as spam (or is still pending)
// shouldn't show up publicly, quote highlight or bottom-list entry alike.
export async function getPostThreadsWithApprovedComments(postId: string): Promise<ThreadWithComments[]> {
  const threads = await prisma.commentThread.findMany({
    where: { postId },
    orderBy: { createdAt: "asc" },
    include: {
      comments: {
        where: { status: "APPROVED" },
        orderBy: { createdAt: "asc" },
        include: {
          commenter: { select: { userId: true, displayName: true, email: true, user: { select: { color: true } } } },
        },
      },
    },
  });

  return threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread) => {
      // comments is ordered by createdAt asc and already filtered to
      // non-empty, so [0] is the earliest approved comment — a reasonable
      // proxy for "whoever opened the thread" even in the rare case where
      // the true root comment is still pending/spam and a reply approved
      // ahead of it.
      const opener = thread.comments[0].commenter;
      const color = opener.user?.color ?? colorForSeed(opener.email);
      return {
        id: thread.id,
        anchorFrom: thread.anchorFrom,
        anchorTo: thread.anchorTo,
        quotedText: thread.quotedText,
        status: thread.status,
        anchoredRevisionId: thread.anchoredRevisionId,
        color,
        comments: thread.comments.map((c) => ({
          id: c.id,
          parentCommentId: c.parentCommentId,
          displayName: c.commenter.displayName,
          bodyText: (c.body as { text?: string } | null)?.text ?? "",
          createdAt: c.createdAt.toISOString(),
          deletedByUserId: c.deletedByUserId,
          commenterUserId: c.commenter.userId,
        })),
      };
    });
}

// The annotation-loader half of the shared view-model (PLAN.md §12i) — same
// return shape as getPostThreadsWithApprovedComments, built very
// differently since there's no separate thread table: a root annotation
// (parentAnnotationId null) *is* the thread, and every reply — including a
// reply-of-a-reply, same nesting CommentNode already recurses through for
// posts — is grouped under it by walking parentAnnotationId pointers back
// to their root. No status filter: annotations are never moderated, so
// every non-deleted-or-not row is eligible (deleted ones still fetched, same
// as posts, so CommentNode can render "[deleted]" for one with live
// replies).
export async function getDocAnnotationsAsThreads(docId: string): Promise<ThreadWithComments[]> {
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

  const threads: ThreadWithComments[] = [];
  for (const [rootId, members] of byRoot) {
    const root = byId.get(rootId);
    if (!root) continue;
    const quotedText = proseJson && markedIds.has(rootId) ? extractMarkedText(proseJson, "annotation", "id", rootId) : "";
    threads.push({
      id: rootId,
      anchorFrom: null,
      anchorTo: null,
      quotedText,
      status: "ACTIVE",
      anchoredRevisionId: null,
      color: root.user.color,
      comments: members.map((a) => ({
        id: a.id,
        parentCommentId: a.parentAnnotationId,
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
