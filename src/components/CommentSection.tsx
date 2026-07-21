import { auth } from "@/lib/auth";
import { getPostThreadsWithApprovedComments, getDetachedThreadContext } from "@/lib/comment-data";
import CommentForm from "./CommentForm";
import CommentEntryList, { type CommentEntry } from "./CommentEntryList";
import { type CommentNodeData } from "./CommentNode";
import styles from "./CommentSection.module.css";

function buildTree(
  flat: {
    id: string;
    parentCommentId: string | null;
    displayName: string;
    bodyText: string;
    createdAt: string;
    deletedByUserId: string | null;
    commenterUserId: string | null;
  }[],
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
  const viewerId = session?.user?.id ?? null;
  const isAdmin = session?.user?.role === "ADMIN";

  const threads = await getPostThreadsWithApprovedComments(postId);
  const generalThread = threads.find((t) => t.quotedText === "");
  const quoteThreads = threads.filter((t) => t.quotedText !== "");

  const detachedContextByThread = new Map<string, string | null>();
  for (const thread of quoteThreads) {
    if (thread.status === "DETACHED") {
      detachedContextByThread.set(
        thread.id,
        await getDetachedThreadContext(thread.anchoredRevisionId, thread.anchorFrom, thread.anchorTo),
      );
    }
  }

  const entries: CommentEntry[] = [
    ...quoteThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: thread.quotedText,
        anchorFrom: thread.anchorFrom,
        status: thread.status,
        context: detachedContextByThread.get(thread.id) ?? null,
        color: thread.color,
        root,
      })),
    ),
    ...(generalThread
      ? buildTree(generalThread.comments).map((root) => ({
          threadId: generalThread.id,
          quotedText: "",
          anchorFrom: null,
          status: generalThread.status,
          context: null,
          color: generalThread.color,
          root,
        }))
      : []),
  ];

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>Comments</h2>
      <CommentForm postId={postId} userName={userName} />

      {threads.length === 0 ? (
        <p className={styles.empty}>No comments yet.</p>
      ) : (
        <CommentEntryList
          entries={entries}
          postId={postId}
          userName={userName}
          viewerId={viewerId}
          isAdmin={isAdmin}
        />
      )}
    </section>
  );
}
