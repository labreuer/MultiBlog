import StarterKit from "@tiptap/starter-kit";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AuthorHighlight } from "./author-highlight-extension";

// The node/mark schema used for a post's content. Shared between the
// editor, the Hocuspocus doc-seeding step, and the public renderer so
// they can never drift out of sync with each other.
export const contentExtensions = [StarterKit];

// The same schema as a plain prosemirror-model Schema, for code that walks
// or diffs docs outside a live editor instance (anchor remapping, detached
// thread context) — also shared so it can't drift from contentExtensions.
export const pmSchema = getSchema(contentExtensions);

// contentExtensions plus the author-highlight mark: used by the live editor
// and by anything reconstructing/rendering the *working* Yjs session (which
// can contain author-highlight marks). Never used for revisions.doc content —
// that's always stripped via stripMarkFromDoc before it's persisted, so
// contentExtensions (without this mark) stays the schema for public/historic
// content and can't drift from it.
export const authorHighlightExtensions = [...contentExtensions, AuthorHighlight];

// ProseMirror builds every non-empty node/mark `attrs` object via
// `Object.create(null)` (computeAttrs, prosemirror-model), and Node/Mark#toJSON
// passes that null-prototype object straight through into editor.getJSON()'s
// output. React's Server Action argument encoder treats any object whose
// prototype isn't Object.prototype as opaque and silently replaces it with an
// inert "$T" placeholder that throws the moment server code (e.g. Prisma's
// jsonb serialization) tries to read it — surfacing as "Cannot access
// toStringTag on the server. You cannot dot into a temporary client
// reference...". Only docs with attrs-bearing marks/nodes (authorHighlight,
// orderedList's start, heading levels, etc.) hit this. A JSON round-trip
// forces every nested object back to a plain prototype before it crosses the
// client/server boundary.
export function toPlainJSON(doc: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(doc));
}

function walkMarks(node: JSONContent, visit: (mark: NonNullable<JSONContent["marks"]>[number]) => void): void {
  node.marks?.forEach(visit);
  node.content?.forEach((child) => walkMarks(child, visit));
}

// Recursively removes every mark of `markName` from a ProseMirror JSON doc.
// Used to keep author-highlight (working-session-only) out of anything
// persisted to revisions.doc.
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    // Destructure marks/content out of the base spread — `{...node, ...(cond
    // ? {marks} : {})}` spreads node's *original, unfiltered* marks first,
    // so when the conditional half contributes nothing (the filtered array
    // is empty — the common case for a text run whose only mark was the one
    // being stripped), nothing overrides it and the unfiltered marks leak
    // straight through unstripped.
    const { marks: rawMarks, content: rawContent, ...rest } = node;
    const marks = rawMarks?.filter((mark) => mark.type !== markName);
    const content = rawContent?.map(strip);
    return {
      ...rest,
      // Omit the key entirely when filtering leaves nothing, rather than
      // keeping `marks: []` — ProseMirror's own Node#toJSON never emits an
      // empty marks array either, so leaving one in here made a freshly
      // stripped doc structurally unequal (per docsEqual) to the identical
      // content coming back from a live editor's getJSON() a moment later,
      // spuriously creating a no-op revision on save-then-publish.
      ...(marks !== undefined && marks.length > 0 ? { marks } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }
  return strip(doc);
}

// Collects the distinct values of a given mark attribute across a doc, e.g.
// every authorId referenced by authorHighlight marks — used to know which
// users' colors need fetching for rendering.
export function collectMarkAttrValues(doc: JSONContent, markName: string, attrName: string): string[] {
  const values = new Set<string>();
  walkMarks(doc, (mark) => {
    if (mark.type === markName) {
      const value = mark.attrs?.[attrName];
      if (typeof value === "string" && value) {
        values.add(value);
      }
    }
  });
  return Array.from(values);
}

// Same idea as collectMarkAttrValues, but walks a *live* ProseMirror Node via
// descendants() instead of a getJSON() snapshot, and sums text length per
// attribute value in the same pass — used for the author-highlight status
// line so it doesn't need a second full-document serialize/walk on top of
// whatever else is already collecting authorIds.
export function collectAuthorHighlightStats(
  doc: PMNode,
  markName: string,
  attrName: string,
): { authorIds: string[]; charsByAuthor: Record<string, number> } {
  const charsByAuthor: Record<string, number> = {};
  doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    for (const mark of node.marks) {
      if (mark.type.name !== markName) continue;
      const value = mark.attrs[attrName];
      if (typeof value === "string" && value) {
        charsByAuthor[value] = (charsByAuthor[value] ?? 0) + node.text.length;
      }
    }
  });
  return { authorIds: Object.keys(charsByAuthor), charsByAuthor };
}
