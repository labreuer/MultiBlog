import { renderToReactElement } from "@tiptap/static-renderer";
import { getDocAnnotationsAsThreads, type AnnotationComment } from "@/lib/annotation-data";
import { annotationContentExtensions } from "@/lib/tiptap-schema";
import NewAnnotationComposer from "./NewAnnotationComposer";
import AnnotationList, { type AnnotationEntry } from "./AnnotationList";
import { type AnnotationNodeData } from "./AnnotationNode";
import AnnotationColorStyles from "./AnnotationColorStyles";
import styles from "./AnnotationSection.module.css";

// A static rendering of the annotation's ydoc cache — the same
// @tiptap/static-renderer call the doc reading view already uses for its
// own body (app/doc/[slug]/page.tsx), never a live editor for a comment
// that isn't currently open in one (PLAN.md §13j Phase 2).
function renderBody(a: AnnotationComment) {
  if (!a.proseJson) return a.bodyText;
  try {
    return renderToReactElement({ content: a.proseJson, extensions: annotationContentExtensions });
  } catch {
    return a.bodyText;
  }
}

function buildTree(comments: AnnotationComment[]): AnnotationNodeData[] {
  const byId = new Map<string, AnnotationNodeData>();
  for (const a of comments) {
    byId.set(a.id, {
      id: a.id,
      displayName: a.displayName,
      body: renderBody(a),
      createdAt: a.createdAt,
      deletedByUserId: a.deletedByUserId,
      commenterUserId: a.commenterUserId,
      replies: [],
    });
  }
  const roots: AnnotationNodeData[] = [];
  for (const a of comments) {
    const node = byId.get(a.id)!;
    const parent = a.parentAnnotationId ? byId.get(a.parentAnnotationId) : undefined;
    if (parent) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// The doc-side sibling of CommentSection (PLAN.md §13c) — un-shared from it
// now that an annotation body is becoming its own collaborative document
// rather than a plain textarea (§12i's "one view-model feeds the shared
// presentation" no longer holds once the two sides stop having the same
// rendering problem). A doc can have more than one "" (general-discussion)
// thread — every annotation whose mark is gone (§12h) plus any genuinely
// general one — so every one of them renders, not just the first, unlike a
// post's single general thread.
export default async function AnnotationSection({ docId }: { docId: string }) {
  const threads = await getDocAnnotationsAsThreads(docId);
  const quoteThreads = threads.filter((t) => t.quotedText !== "");
  const generalThreads = threads.filter((t) => t.quotedText === "");

  const entries: AnnotationEntry[] = [
    ...quoteThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: thread.quotedText,
        anchorFrom: thread.anchorFrom,
        color: thread.color,
        root,
      })),
    ),
    ...generalThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: "",
        anchorFrom: null,
        color: thread.color,
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
      <AnnotationColorStyles colors={Object.fromEntries(quoteThreads.map((t) => [t.id, t.color]))} />
      <h2 className={styles.heading}>Annotations</h2>
      <NewAnnotationComposer docId={docId} />

      {threads.length === 0 ? (
        <p className={styles.empty}>No annotations yet.</p>
      ) : (
        <AnnotationList entries={entries} docId={docId} />
      )}
    </section>
  );
}
