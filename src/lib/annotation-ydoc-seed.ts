import * as Y from "yjs";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { JSONContent } from "@tiptap/core";
import { pmAnnotationContentSchema } from "./tiptap-schema";

// PLAN.md §13b/§13d — builds the initial state for a freshly-created
// annotation's own ydoc from plain text: one paragraph, no marks. Used by
// submitAnnotation (a brand-new annotation) and
// scripts/backfill-annotation-ydocs.ts (an existing annotation's `body.text`)
// so the two never drift on what "seed a ydoc from text" means. A `Y.Doc`
// works the same way in the Next web process as in the collab process — Yjs
// itself has no server/collab-only requirement, and src/app/api/ydoc/route.ts
// already establishes the pattern of the web process writing directly into
// the ydoc store (§12b) rather than going through Hocuspocus for a brand-new,
// not-yet-connected document.
export function seedAnnotationYdoc(text: string): {
  ydoc: Uint8Array;
  stateVector: Uint8Array;
  proseJson: JSONContent;
} {
  const paragraph = text
    ? pmAnnotationContentSchema.node("paragraph", null, pmAnnotationContentSchema.text(text))
    : pmAnnotationContentSchema.node("paragraph");
  const doc = pmAnnotationContentSchema.node("doc", null, paragraph);

  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment("default"));
  const state = { ydoc: Y.encodeStateAsUpdate(ydoc), stateVector: Y.encodeStateVector(ydoc) };
  ydoc.destroy();

  return { ...state, proseJson: doc.toJSON() as JSONContent };
}

/**
 * docs/MCP.md §9 — the initial state for an annotation the MCP server writes
 * whole: the body parsed from Markdown, seeded straight into the ydoc rather
 * than typed over a websocket.
 *
 * **The seed carries no `authorHighlight` mark**, as a solo body typed in the
 * UI carries none: AnnotationBody turns the mark on only once the body's
 * `clients` map holds two distinct users, and PLAN.md §13h's one-time
 * backfill then marks everything already there as the annotation's author's.
 *
 * **Its Yjs client is registered in `clients` as `userId`.** The UI's seed is
 * empty and its first writer arrives over the websocket, where
 * attributeUpdate registers them; this seed is the whole body, written
 * directly, which registers nobody — and without the entry a person who later
 * joins would be the body's first distinct user rather than its second, and
 * the backfill would never run.
 */
export function seedAnnotationYdocFromJson(
  json: JSONContent,
  userId: string,
): { ydoc: Uint8Array; stateVector: Uint8Array; proseJson: JSONContent } {
  const node = pmAnnotationContentSchema.nodeFromJSON(json);
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(node, ydoc.getXmlFragment("default"));
  ydoc.getMap<string>("clients").set(String(ydoc.clientID), userId);
  const state = { ydoc: Y.encodeStateAsUpdate(ydoc), stateVector: Y.encodeStateVector(ydoc) };
  ydoc.destroy();
  return { ...state, proseJson: node.toJSON() as JSONContent };
}
