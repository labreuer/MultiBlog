import { prisma } from "@/lib/prisma";
import { pmSchema } from "@/lib/tiptap-schema";
import { colorForSeed } from "@/lib/author-colors";
import type { ThreadStatus } from "@/generated/prisma/enums";

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
  anchorFrom: number;
  anchorTo: number;
  quotedText: string;
  status: ThreadStatus;
  anchoredRevisionId: string;
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
