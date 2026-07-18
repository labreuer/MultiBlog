import { auth } from "@/lib/auth";
import { getPostThreadsWithApprovedComments } from "@/lib/comment-data";
import CommentForm from "./CommentForm";
import CommentEntryList, { type CommentEntry } from "./CommentEntryList";
import { type CommentNodeData } from "./CommentNode";

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

  const threads = await getPostThreadsWithApprovedComments(postId);
  const generalThread = threads.find((t) => t.quotedText === "");
  const quoteThreads = threads.filter((t) => t.quotedText !== "");

  const entries: CommentEntry[] = [
    ...quoteThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: thread.quotedText,
        anchorFrom: thread.anchorFrom,
        root,
      })),
    ),
    ...(generalThread
      ? buildTree(generalThread.comments).map((root) => ({
          threadId: generalThread.id,
          quotedText: "",
          anchorFrom: null,
          root,
        }))
      : []),
  ];

  return (
    <section style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #ddd" }}>
      <h2>Comments</h2>
      <CommentForm postId={postId} userName={userName} />

      {threads.length === 0 ? (
        <p style={{ color: "#666" }}>No comments yet.</p>
      ) : (
        <CommentEntryList entries={entries} postId={postId} userName={userName} />
      )}
    </section>
  );
}
