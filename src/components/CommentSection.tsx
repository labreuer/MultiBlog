import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import CommentForm from "./CommentForm";
import CommentNode, { type CommentNodeData } from "./CommentNode";

function buildTree(
  flat: { id: string; parentCommentId: string | null; displayName: string; bodyText: string; createdAt: string }[],
): CommentNodeData[] {
  const byId = new Map<string, CommentNodeData>();
  for (const c of flat) {
    byId.set(c.id, { ...c, replies: [] });
  }
  const roots: CommentNodeData[] = [];
  for (const c of flat) {
    const node = byId.get(c.id)!;
    const parent = c.parentCommentId ? byId.get(c.parentCommentId) : undefined;
    if (parent) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export default async function CommentSection({ postId }: { postId: string }) {
  const session = await auth();
  const userName = session?.user ? (session.user.name ?? session.user.email ?? null) : null;

  const thread = await prisma.commentThread.findFirst({ where: { postId, quotedText: "" } });
  const comments = thread
    ? await prisma.comment.findMany({
        where: { threadId: thread.id, status: "APPROVED" },
        orderBy: { createdAt: "asc" },
        include: { commenter: { select: { displayName: true } } },
      })
    : [];

  const tree = buildTree(
    comments.map((c) => ({
      id: c.id,
      parentCommentId: c.parentCommentId,
      displayName: c.commenter.displayName,
      bodyText: (c.body as { text?: string } | null)?.text ?? "",
      createdAt: c.createdAt.toISOString(),
    })),
  );

  return (
    <section style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #ddd" }}>
      <h2>Comments</h2>
      <CommentForm postId={postId} userName={userName} />
      {tree.length === 0 ? (
        <p style={{ color: "#666" }}>No comments yet.</p>
      ) : (
        tree.map((c) => <CommentNode key={c.id} comment={c} postId={postId} userName={userName} />)
      )}
    </section>
  );
}
