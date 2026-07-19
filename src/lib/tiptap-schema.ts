import StarterKit from "@tiptap/starter-kit";
import { getSchema, type JSONContent } from "@tiptap/core";
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

function walkMarks(node: JSONContent, visit: (mark: NonNullable<JSONContent["marks"]>[number]) => void): void {
  node.marks?.forEach(visit);
  node.content?.forEach((child) => walkMarks(child, visit));
}

// Recursively removes every mark of `markName` from a ProseMirror JSON doc.
// Used to keep author-highlight (working-session-only) out of anything
// persisted to revisions.doc.
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    const marks = node.marks?.filter((mark) => mark.type !== markName);
    const content = node.content?.map(strip);
    return {
      ...node,
      ...(marks !== undefined ? { marks } : {}),
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
