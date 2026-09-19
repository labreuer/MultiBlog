import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Strike from "@tiptap/extension-strike";
import Code from "@tiptap/extension-code";
import Blockquote from "@tiptap/extension-blockquote";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import HardBreak from "@tiptap/extension-hard-break";
import Link from "@tiptap/extension-link";
import { Table, TableCell as BaseTableCell, TableHeader as BaseTableHeader, TableRow } from "@tiptap/extension-table";
import { TableViewWithClearedWidths } from "./table-view";
import { Quote } from "./quote-mark-extension";
import { getSchema, mergeAttributes, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { AuthorHighlight } from "./author-highlight-extension";
import { Annotation } from "./annotation-extension";

// StarterKit's Link options for a *live* editor. CollabEditorBody and
// AnnotationBody each build their own StarterKit (undo/redo off, since
// Collaboration owns history) and both take these, so they can't drift.
// Only Link's click plugin is affected — contentExtensions below is a
// schema, and the mark renders the same either way, so it doesn't need
// them.
//
// openOnClick off: a click in a link places the caret, like a click
// anywhere else. With it on, every click (every tap, on a phone) opened
// the target in a new tab, and there was no way to click *into* link text
// to edit it. The browser had been saying as much all along — the UA
// gives <a> `cursor: auto`, which resolves to the I-beam over editable
// text, so the navigation the plugin bolted on never had an affordance.
// Following a link moved to LinkBubble.tsx, where the href is a real <a>.
// Don't reach for "whenNotEditable" as a middle ground: the installed
// build maps it straight to `true`, and the click plugin already stands
// down in a read-only view, so it is the same setting under another name.
export const EDITOR_LINK_OPTIONS = { openOnClick: false } as const;

// docs/TABLES.md — TipTap's own table nodes, as one list so the live editors
// (CollabEditorBody builds its own StarterKit and adds these beside it) and
// the schema below register exactly the same four types. Not part of
// StarterKit, so docs/TIPTAP.md's "never add StarterKit's own extensions
// beside it" doesn't apply; the extension exists precisely to be added.
//
// renderWrapper: the static renderer emits `<div class="tableWrapper">`
// around the `<table>`, the same element the editor's TableView node view
// draws — so prose.module.css styles one wrapper for both surfaces, and
// that wrapper is the `overflow-x: auto` box STYLE.md's "Adding a new wide
// surface" asks for. resizable stays off: column widths would be cell attrs
// synced through Yjs (fine) but drawn by a drag interaction the reading
// views can't reproduce from the static HTML, and a 800px reading column
// has little to give — TODO.md carries the follow-up.
//
// The cells render `colSpan`/`rowSpan` rather than the extension's own
// `colspan`/`rowspan`. Both spellings are the same attribute to the DOM
// (`setAttribute` lowercases on HTML elements, and `parseHTML` reads the
// lowercase form back), but `@tiptap/static-renderer`'s React path hands
// every attribute name to `React.createElement` verbatim — it translates
// only `class` and `style` — and React wants the camelCase prop, so the
// reading views warned "Invalid DOM property `colspan`" on every cell.
// Renaming here fixes every static-render call site at once instead of a
// `nodeMapping` per call. docs/TIPTAP.md "Tables are four nodes".
const reactCellAttributes = ({ colspan, rowspan, ...rest }: Record<string, unknown>) => ({
  ...rest,
  colSpan: colspan,
  rowSpan: rowspan,
});
export const TableCell = BaseTableCell.extend({
  renderHTML({ HTMLAttributes }) {
    return ["td", reactCellAttributes(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)), 0];
  },
});
export const TableHeader = BaseTableHeader.extend({
  renderHTML({ HTMLAttributes }) {
    return ["th", reactCellAttributes(mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)), 0];
  },
});
//
// View: the stock TableView leaves a stale `width` on a <col> whose column
// has just lost its width — table-view.ts says how, and why "Auto-size
// columns" (docs/TABLES.md) needs it fixed. Harmless in contentExtensions'
// non-editor uses: a node view is only ever constructed by a live editor.
export const tableExtensions = [
  Table.configure({ renderWrapper: true, View: TableViewWithClearedWidths }),
  TableRow,
  TableHeader,
  TableCell,
];

// The node/mark schema used for a post's content. Shared between the
// editor, the Hocuspocus doc-seeding step, and the public renderer so
// they can never drift out of sync with each other.
export const contentExtensions = [StarterKit, ...tableExtensions];

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

// The schema for an annotation's own body (PLAN.md §13b) — StarterKit plus
// the author-highlight mark, and deliberately nothing more. Not
// docContentExtensions: an annotation body can't itself carry the
// `annotation` anchor mark (an annotation on an annotation isn't a thing this
// app has), and picking the wrong variant here would silently let one be
// typed in and then vanish the moment it's re-rendered through a schema that
// doesn't know the mark (docs/TIPTAP.md's "picking the wrong variant silently
// drops marks" warning, restated for a third consumer). And not
// authorHighlightExtensions, which it used to be an alias of: that list
// carries tableExtensions since docs/TABLES.md, and a margin note has no room
// for a table — the same reason ANNOTATION_TOOLS (EditorToolbar.tsx) offers
// no headings. AnnotationBody's own extension list mirrors this one, so the
// live annotation editor and every decoder of its ydoc agree on the shape.
export const annotationContentExtensions = [StarterKit, AuthorHighlight];
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

// PLAN.md §23b — what a stranger may put in a comment. Stated as its own list
// rather than derived from contentExtensions or annotationContentExtensions,
// the same decision canManageDocs vs. canManagePosts records: a delegation
// preserves exactly the coupling the separation exists to break, and "what an
// anonymous commenter may write" has to be able to diverge from "what an author
// may put in a doc" without anyone noticing at the wrong moment. Not
// StarterKit.configure({...: false}) either — a StarterKit release that adds a
// node would widen the one schema here that accepts unauthenticated input.
//
// In: the inline marks people use in prose; lists and blockquote, which
// prose.module.css already restores from globals.css's reset; hard breaks,
// because VirtualKeyboardEnter exists; links, hardened below. Out, and why,
// is §23b's list: images (a stranger-chosen src is a request every reader's
// browser makes), headings, code blocks, tables, rules, and raw HTML — which
// has no extension, so the schema cannot express it and no sanitizer has to
// catch it. `nodeFromJSON` over pmCommentContentSchema is the write-side
// validation, as pmBlurbSchema is for a blurb.
//
// Every link renders with `rel="nofollow noopener"` and `target="_blank"`
// (§6), unconditionally — a trusted commenter's link is still a link to
// somewhere we don't control. The HTMLAttributes here cover the renderer; the
// stored mark's own attrs are overwritten to match by `hardenCommentLinks`
// (comment-body.ts) on every write, so neither depends on the other.
export const COMMENT_LINK_REL = "nofollow noopener";
export const COMMENT_LINK_TARGET = "_blank";

// PLAN.md §23f — a comment's blockquote carries a nullable `anchorId`: the
// `comment_quote_anchor` row this quotation cites, or null for an ordinary
// quote (the toolbar's, or a `>` in the Markdown box that matched nothing).
// One node type rather than a separate `Quotation`: Markdown parses to
// `blockquote`, so promotion is an attribute write and degradation is
// `anchorId: null`, with no node swap either way. What the attribute form
// cannot say structurally — an anchored quote never nests inside another —
// is a server rule in the matcher instead.
export const CommentBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      anchorId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-anchor-id"),
        renderHTML: (attributes) => (attributes.anchorId ? { "data-anchor-id": attributes.anchorId } : {}),
      },
    };
  },
});

export const commentContentExtensions = [
  Document,
  Paragraph,
  Text,
  Bold,
  Italic,
  Strike,
  Code,
  CommentBlockquote,
  Quote,
  BulletList,
  OrderedList,
  ListItem,
  HardBreak,
  Link.configure({
    ...EDITOR_LINK_OPTIONS,
    HTMLAttributes: { rel: COMMENT_LINK_REL, target: COMMENT_LINK_TARGET },
  }),
];
export const pmCommentContentSchema = getSchema(commentContentExtensions);

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
