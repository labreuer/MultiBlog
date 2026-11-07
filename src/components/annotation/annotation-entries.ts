import { annotationContentExtensions } from "@/lib/tiptap-schema";
import { chipInputsForBodies } from "@/lib/entity-chips/context";
import { chipsInJSON } from "@/lib/entity-chips/renderings";
import { renderWithChips } from "@/lib/entity-chips/static";
import type { ChipInputs } from "@/lib/entity-chips/types";
import type { AnnotationComment, AnnotationThread } from "@/lib/annotation-data";
import type { AnnotationEntry } from "./AnnotationList";
import type { AnnotationNodeData } from "./AnnotationNode";

// Server-side only — the static renderer runs here and the finished
// elements ship in the RSC payload, which is what lets an annotation body
// render its rich content without a live editor per card (PLAN.md §13j Phase
// 2). Lifted out of AnnotationSection.tsx unchanged when the doc *editor*
// gained its own annotation rail (§18c): two server components now need the
// identical thread → entry transform, and a second copy of a tree walk is
// exactly the kind of thing that quietly diverges.

// A static rendering of the annotation's ydoc cache — the same
// @tiptap/static-renderer call the doc reading view already uses for its
// own body (app/doc/[slug]/page.tsx), never a live editor for a comment
// that isn't currently open in one. Through `renderWithChips`, so a chip in
// a note shows its label (docs/ENTITY_CHIPS.md, step 1, item 13).
function renderBody(a: AnnotationComment, chipInputs: ChipInputs) {
  if (!a.proseJson) return a.bodyText;
  try {
    return renderWithChips(a.proseJson, annotationContentExtensions, chipInputs);
  } catch {
    return a.bodyText;
  }
}

function buildTree(comments: AnnotationComment[], chipInputs: ChipInputs): AnnotationNodeData[] {
  const byId = new Map<string, AnnotationNodeData>();
  for (const a of comments) {
    byId.set(a.id, {
      id: a.id,
      displayName: a.displayName,
      body: renderBody(a, chipInputs),
      // What the static body above was labelled with, for the editors the
      // card mounts over the same JSON. The one object for every note that
      // holds a chip, which the RSC payload then carries once; nothing for a
      // note that holds none.
      chipInputs: a.proseJson && chipsInJSON(a.proseJson).length > 0 ? chipInputs : undefined,
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
      anchorChips: a.anchorChips,
      color: a.color,
      createdAt: a.createdAt,
      postedAt: a.postedAt,
      deletedByUserId: a.deletedByUserId,
      commenterUserId: a.commenterUserId,
      ydocUpdateId: a.ydocUpdateId,
      // PLAN.md §22e — carried, not derived: the silence rule needs every
      // version's timestamp, and this tree is built on the server precisely
      // so the browser never receives them.
      visiblyEdited: a.visiblyEdited,
      editedAt: a.editedAt,
      editingSince: a.editingSince,
      editSessionStale: a.editSessionStale,
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
//
// Async for the chip context alone: one load for every body in `threads`, and
// no query at all when none of them holds a chip.
export async function buildAnnotationEntries(threads: AnnotationThread[]): Promise<AnnotationEntry[]> {
  const chipInputs = await chipInputsForBodies(threads.flatMap((thread) => thread.comments.map((a) => a.proseJson)));
  const quoteThreads = threads.filter((t) => t.quotedText !== "");
  const generalThreads = threads.filter((t) => t.quotedText === "");

  return [
    ...quoteThreads.flatMap((thread) =>
      buildTree(thread.comments, chipInputs).map((root) => ({
        threadId: thread.id,
        quotedText: thread.quotedText,
        anchorChips: thread.anchorChips,
        anchorFrom: thread.anchorFrom,
        anchorTo: thread.anchorTo,
        color: thread.color,
        root,
      })),
    ),
    ...generalThreads.flatMap((thread) =>
      buildTree(thread.comments, chipInputs).map((root) => ({
        threadId: thread.id,
        quotedText: "",
        // Kept for a mark-anchored thread whose passage is a chip alone: it
        // has no text for a mark to hold, and the record is its whole anchor.
        anchorChips: thread.anchorChips,
        anchorFrom: null,
        anchorTo: null,
        color: thread.color,
        root,
      })),
    ),
  ];
}
