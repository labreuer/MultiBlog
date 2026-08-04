import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AuthorHighlight } from "./author-highlight-extension";
import { Annotation } from "./annotation-extension";

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

// The doc-side extension set (PLAN.md §12i), beside authorHighlightExtensions
// rather than folded into it: posts never apply the annotation mark, but an
// unused mark type in a shared schema costs nothing, exactly as
// authorHighlight already demonstrates for the reverse case. Used for
// anything decoding/encoding a *doc's* ydoc: server/doc-cache.ts,
// src/lib/ydoc-render.ts, and the doc-side live editor/reading view.
export const docContentExtensions = [...authorHighlightExtensions, Annotation];

// The plain prosemirror-model Schema counterpart of docContentExtensions —
// for server-side code that builds/walks a doc-shaped Node outside a live
// editor instance (server/ydoc-hooks.ts's annotation-mark endpoint), mirroring
// pmSchema/pmTitleSchema above.
export const pmDocContentSchema = getSchema(docContentExtensions);

// The schema for an annotation's own body (PLAN.md §13b) — deliberately
// authorHighlightExtensions alone, not docContentExtensions: an annotation
// body can't itself carry the `annotation` anchor mark (an annotation on an
// annotation isn't a thing this app has), and picking the wrong variant here
// would silently let one be typed in and then vanish the moment it's
// re-rendered through a schema that doesn't know the mark (CLAUDE.md's
// "picking the wrong variant silently drops marks" warning, restated for a
// third consumer).
export const annotationContentExtensions = authorHighlightExtensions;
export const pmAnnotationContentSchema = getSchema(annotationContentExtensions);

// The schema for a post's *title*, which lives in its own Yjs fragment
// ("title") of the same Y.Doc as the body rather than as a node inside the
// body doc — a node at position 0 would shift every body position, and
// CommentThread.anchorFrom/anchorTo (see anchor-remap.ts) are absolute
// positions. Deliberately not StarterKit: `content: "paragraph"` (exactly
// one, not `block+`) makes a second block structurally impossible, so
// neither Enter nor a multi-line paste can turn a title into two lines, and
// no marks are registered so a title can't carry bold/links/etc.
//
// Shared with the Hocuspocus seeding step and LiveHistoryViewer's replay,
// same reason as contentExtensions above: three consumers, one definition.
export const titleExtensions = [Document.extend({ content: "paragraph" }), Paragraph, Text];

// The title schema as a plain prosemirror-model Schema — the title-fragment
// counterpart of pmSchema, for code that builds a title doc outside a live
// editor (server/collab.ts's restore endpoint).
export const pmTitleSchema = getSchema(titleExtensions);

// titleExtensions plus the author-highlight mark — the title editor and
// anything rendering the working Yjs session's title. Mirrors
// authorHighlightExtensions/contentExtensions: the mark never reaches
// revisions.title (a plain string column, extracted as text on save), so
// titleExtensions alone stays the schema for saved titles.
export const titleAuthorHighlightExtensions = [...titleExtensions, AuthorHighlight];

// The schema for a contributor's blurb (PLAN.md §17f) — a plain `User`
// column, not a ydoc: one owner, no history, no concurrent editors, edited
// from a single explicit Save on /dashboard rather than a live session.
// `content: "paragraph"` is titleExtensions' trick reused for the same
// reason — a one-line sidebar entry can't grow into a stack of paragraphs
// structurally, not by CSS clamp. StarterKit is not an option here: every
// node/mark in StarterKitOptions can be individually disabled *except*
// `document` and `text` (checked against @tiptap/starter-kit@3.29.0's
// types), so "exactly one paragraph" is only reachable by building the
// extension list from scratch, same as titleExtensions already does. Bold
// and Italic are the only marks — no Link: the contributor card already has
// dedicated orcid/website fields, so the one link a blurb would plausibly
// want is a field already, not something to parse out of prose.
export const blurbExtensions = [Document.extend({ content: "paragraph" }), Paragraph, Text, Bold, Italic];

// The plain prosemirror-model Schema counterpart of blurbExtensions, used by
// the write path (actions/contributor.ts, actions/users.ts) to validate a
// submitted blurb via nodeFromJSON — throws on any node/mark the schema
// doesn't define, which is the whole of this column's write-side validation
// (PLAN.md §17f: the schema *is* the validation, not an HTML allowlist).
export const pmBlurbSchema = getSchema(blurbExtensions);

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

// stripMarkFromDoc applied for each name in turn — PLAN.md §15b. A post's
// content comes from a doc's ydoc, decoded with docContentExtensions (which
// carries authorHighlight and annotation, neither of which every post-side
// consumer's plain contentExtensions/pmSchema knows about); publishing must
// strip both before the content ever reaches Post.proseJson, not one and then
// the other by hand at the call site where it's easy to forget the second.
export function stripMarksFromDoc(doc: JSONContent, markNames: string[]): JSONContent {
  return markNames.reduce((acc, markName) => stripMarkFromDoc(acc, markName), doc);
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

// The doc-side counterpart of collectMarkAttrValues (PLAN.md §12i): instead
// of collecting attribute values, concatenates the text of every run that
// carries markName/attrName === attrValue, in document order — used to read
// an annotation's quoted text back out of Doc.proseJson at render time,
// since nothing stores it separately. A contiguous annotated range can be
// split into several adjacent text nodes (different bold/italic runs, etc.),
// but never discontiguous — it was applied as one addMark(from, to) call —
// so concatenation in document order always reconstructs the original span.
export function extractMarkedText(doc: JSONContent, markName: string, attrName: string, attrValue: string): string {
  const parts: string[] = [];
  function walk(node: JSONContent) {
    if (node.type === "text" && node.text) {
      const hasMark = node.marks?.some((mark) => mark.type === markName && mark.attrs?.[attrName] === attrValue);
      if (hasMark) parts.push(node.text);
    }
    node.content?.forEach(walk);
  }
  walk(doc);
  return parts.join("");
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
