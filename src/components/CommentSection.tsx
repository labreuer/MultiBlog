import {
  getPostThreadsWithApprovedComments,
  getDocAnnotationsAsThreads,
  getDetachedThreadContext,
  type CommentTarget,
} from "@/lib/comment-data";
import CommentForm from "./CommentForm";
import CommentEntryList, { type CommentEntry } from "./CommentEntryList";
import { type CommentNodeData } from "./CommentNode";
import AnnotationColorStyles from "./AnnotationColorStyles";
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

export default async function CommentSection({ target }: { target: CommentTarget }) {
  const threads = target.kind === "post" ? await getPostThreadsWithApprovedComments(target.id) : await getDocAnnotationsAsThreads(target.id);
  const quoteThreads = threads.filter((t) => t.quotedText !== "");
  // A post has at most one general thread (found-or-created keyed on
  // quotedText: "", src/app/actions/comments.ts) — but a doc can have many
  // "" entries (every annotation whose mark is gone, §12h, plus any
  // genuinely general one), so every one of them renders, not just the
  // first. Filtering here rather than finding is a no-op for posts and
  // correct for docs.
  const generalThreads = threads.filter((t) => t.quotedText === "");

  const detachedContextByThread = new Map<string, string | null>();
  for (const thread of quoteThreads) {
    // Never true for a doc-sourced thread (§12i) — annotations don't use
    // DETACHED, so this stays post-only without an explicit target check.
    if (thread.status === "DETACHED" && thread.anchoredRevisionId !== null) {
      detachedContextByThread.set(
        thread.id,
        await getDetachedThreadContext(thread.anchoredRevisionId, thread.anchorFrom!, thread.anchorTo!),
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
    ...generalThreads.flatMap((generalThread) =>
      buildTree(generalThread.comments).map((root) => ({
        threadId: generalThread.id,
        quotedText: "",
        anchorFrom: null,
        status: generalThread.status,
        context: null,
        color: generalThread.color,
        root,
      })),
    ),
  ];

  return (
    <section className={styles.section} data-comment-section>
      {/* Colors the reading/editing view's annotation highlights by their
          author, same as AuthorHighlightStyles does for attributed body
          text — a <style> tag's attribute-selector rules apply document-wide
          regardless of where it sits in the tree, so rendering it here
          (rather than up in LiveDocBody, which has no reason to know about
          annotation authorship) is fine. */}
      {target.kind === "doc" && (
        <AnnotationColorStyles colors={Object.fromEntries(quoteThreads.map((t) => [t.id, t.color]))} />
      )}
      <h2 className={styles.heading}>{target.kind === "doc" ? "Annotations" : "Comments"}</h2>
      <CommentForm target={target} />

      {threads.length === 0 ? (
        <p className={styles.empty}>{target.kind === "doc" ? "No annotations yet." : "No comments yet."}</p>
      ) : (
        <CommentEntryList entries={entries} target={target} />
      )}
    </section>
  );
}
