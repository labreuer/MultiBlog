import { prisma } from "@/lib/prisma";

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
  comments: ThreadComment[];
};

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
      comments: thread.comments.map((c) => ({
        id: c.id,
        parentCommentId: c.parentCommentId,
        displayName: c.commenter.displayName,
        bodyText: (c.body as { text?: string } | null)?.text ?? "",
        createdAt: c.createdAt.toISOString(),
      })),
    }));
}
