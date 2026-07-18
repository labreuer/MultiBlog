import { prisma } from "@/lib/prisma";
import { pmSchema } from "@/lib/tiptap-schema";
import type { ThreadStatus } from "@/generated/prisma/enums";

export type ThreadComment = {
  id: string;
  parentCommentId: string | null;
  displayName: string;
  bodyText: string;
  createdAt: string;
};

export type ThreadWithComments = {
  id: string;
  anchorFrom: number;
  anchorTo: number;
  quotedText: string;
  status: ThreadStatus;
  anchoredRevisionId: string;
  comments: ThreadComment[];
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
        include: { commenter: { select: { displayName: true } } },
      },
    },
  });

  return threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread) => ({
      id: thread.id,
      anchorFrom: thread.anchorFrom,
      anchorTo: thread.anchorTo,
      quotedText: thread.quotedText,
      status: thread.status,
      anchoredRevisionId: thread.anchoredRevisionId,
      comments: thread.comments.map((c) => ({
        id: c.id,
        parentCommentId: c.parentCommentId,
        displayName: c.commenter.displayName,
        bodyText: (c.body as { text?: string } | null)?.text ?? "",
        createdAt: c.createdAt.toISOString(),
      })),
    }));
}
