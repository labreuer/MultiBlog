import { renderToReactElement } from "@tiptap/static-renderer";
import { annotationContentExtensions } from "@/lib/tiptap-schema";
import type { AnnotationComment, AnnotationThread } from "@/lib/annotation-data";
import type { AnnotationEntry } from "./AnnotationList";
import type { AnnotationNodeData } from "./AnnotationNode";

// Server-side only — `renderToReactElement` runs here and the finished
// elements ship in the RSC payload, which is what lets an annotation body
// render its rich content without a live editor per card (PLAN.md §13j Phase
// 2). Lifted out of AnnotationSection.tsx unchanged when the doc *editor*
// gained its own annotation rail (§18c): two server components now need the
// identical thread → entry transform, and a second copy of a tree walk is
// exactly the kind of thing that quietly diverges.

// A static rendering of the annotation's ydoc cache — the same
// @tiptap/static-renderer call the doc reading view already uses for its
// own body (app/doc/[slug]/page.tsx), never a live editor for a comment
// that isn't currently open in one.
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
      // PLAN.md §13p — the same content the static tree above was built
      // from, shipped alongside it because AnnotationBodyReader needs the
      // JSON (not the rendered elements) to seed its own editor. Both, not
      // one: the tree is what a reader with no JS gets and what covers the
      // pre-ready frame; the JSON is what makes the body selectable.
      proseJson: a.proseJson,
      // PLAN.md §13p — a reply's anchor into this annotation's parent, carried
      // down so AnnotationNode can hand its *parent's* body the set of
      // highlights to draw. Zero for a root.
      anchorFrom: a.anchorFrom,
      anchorTo: a.anchorTo,
      quotedText: a.quotedText,
      color: a.color,
      createdAt: a.createdAt,
      deletedByUserId: a.deletedByUserId,
      commenterUserId: a.commenterUserId,
      ydocUpdateId: a.ydocUpdateId,
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

// Quote-anchored threads first, then general-discussion ones. A doc can have
// more than one "" thread — every annotation whose mark is gone (§12h) plus
// any genuinely general one — so every one of them is included, not just the
// first, unlike a post's single general thread.
export function buildAnnotationEntries(threads: AnnotationThread[]): AnnotationEntry[] {
  const quoteThreads = threads.filter((t) => t.quotedText !== "");
  const generalThreads = threads.filter((t) => t.quotedText === "");

  return [
    ...quoteThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: thread.quotedText,
        anchorFrom: thread.anchorFrom,
        anchorTo: thread.anchorTo,
        color: thread.color,
        root,
      })),
    ),
    ...generalThreads.flatMap((thread) =>
      buildTree(thread.comments).map((root) => ({
        threadId: thread.id,
        quotedText: "",
        anchorFrom: null,
        anchorTo: null,
        color: thread.color,
        root,
      })),
    ),
  ];
}
