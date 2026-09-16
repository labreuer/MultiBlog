// Markdown -> TipTap JSON for /docs' Markdown import, server-side and headless.
// Why MarkdownManager rather than an Editor, what raw HTML in the source turns
// into, and the reasoning behind the title rule below: docs/DOC_IMPORT.md.

import { MarkdownManager } from "@tiptap/markdown";
import { decodeHTML } from "entities";
import { Extension, type JSONContent, type MarkdownParseHelpers, type MarkdownToken } from "@tiptap/core";
import { commentContentExtensions, contentExtensions } from "./tiptap-schema";

// contentExtensions, and specifically the same exported value the caller
// encodes the ydoc with — a node type registered here but missing there is
// dropped silently on encode rather than reported (docs/DOC_IMPORT.md §2).
const markdownManager = new MarkdownManager({ extensions: contentExtensions });

export type MarkdownImport = {
  // Always a valid `doc` node with at least one block: the schema's content is
  // `block+`, so an empty content array fails to encode.
  body: JSONContent;
  // The leading heading's text if there was one to consume, else null — null
  // means "caller supplies a fallback", never "untitled".
  title: string | null;
};

// Entity references arrive from the parse as literal text — `marked` is an HTML
// emitter, so leaving them encoded is right for its purpose, and
// @tiptap/markdown decodes only `&lt; &gt; &quot; &amp;` on top of that. Every
// other named reference and every numeric one would otherwise reach a
// ProseMirror text node verbatim and render as its own source.
//
// DECODING ONLY — nothing is removed on the way in. A reference names a
// character and becomes that character, including the invisible ones: a
// `&#8203;` in the source arrives as a real zero-width space, not as nothing.
// Deleting characters an author wrote is a separate decision from decoding
// them, and this function does not make it.
//
// Code is exempt, and must stay exempt: CommonMark does not decode entity
// references inside a code span or fence, so `&lt;` there is genuinely the four
// characters. That is why a `codeBlock` is returned untouched rather than
// walked, and why a text node carrying the `code` mark keeps its text.
//
// Link destinations ARE decoded (docs/DOC_IMPORT.md §5): CommonMark decodes
// entity references there too, so a URL imported with `&amp;` as its query
// separator is wrong, not merely ugly.
export function decodeNodeEntities(node: JSONContent): JSONContent {
  if (node.type === "codeBlock") {
    return node;
  }

  let out = node;

  if (typeof out.text === "string" && !out.marks?.some((mark) => mark.type === "code")) {
    out = { ...out, text: decodeHTML(out.text) };
  }

  if (out.marks?.some((mark) => mark.type === "link" && typeof mark.attrs?.href === "string")) {
    out = {
      ...out,
      marks: out.marks.map((mark) =>
        mark.type === "link" && typeof mark.attrs?.href === "string"
          ? { ...mark, attrs: { ...mark.attrs, href: decodeHTML(mark.attrs.href) } }
          : mark,
      ),
    };
  }

  if (out.content) {
    out = { ...out, content: out.content.map(decodeNodeEntities) };
  }

  return out;
}

function plainText(node: JSONContent): string {
  if (typeof node.text === "string") {
    return node.text;
  }
  return (node.content ?? []).map(plainText).join("");
}

function headingLevel(node: JSONContent | undefined): number | null {
  if (node?.type !== "heading") {
    return null;
  }
  const level = node.attrs?.level;
  return typeof level === "number" ? level : null;
}

export function markdownToDocContent(markdown: string): MarkdownImport {
  const parsed = decodeNodeEntities(markdownManager.parse(markdown));
  const blocks = Array.isArray(parsed.content) ? [...parsed.content] : [];

  // Consume the first block as the title if it is a heading at the SHALLOWEST
  // level the document uses — so `# Name` and a file that starts at `## Name`
  // both give one up, while a leading H2 in a file that also uses H1 stays put.
  // Top-level blocks only. Worked through, with the cases: docs/DOC_IMPORT.md §4.
  const levels = blocks.map(headingLevel).filter((level): level is number => level !== null);
  const topLevel = levels.length > 0 ? Math.min(...levels) : null;

  let title: string | null = null;
  if (topLevel !== null && headingLevel(blocks[0]) === topLevel) {
    const text = plainText(blocks[0]).trim();
    if (text) {
      title = text;
      blocks.shift();
    }
  }

  return {
    title,
    body: { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] },
  };
}

// ---------------------------------------------------------------------------
// PLAN.md §23m — the second consumer: a comment typed as Markdown.
//
// **The schema does not restrict the parser; these shims do.** Measured on
// @tiptap/markdown 3.29 (docs/DOC_IMPORT.md §11): the manager's fallback emits
// a `heading` node whether or not Heading is registered — so one `#` line
// would make nodeFromJSON throw and the whole comment be refused — and returns
// nothing at all for a fenced code block or a table, silently deleting a
// commenter's code sample. Each shim is a bare `Extension` whose
// `markdownTokenName` is the token the fallback mishandles and whose
// `parseMarkdown` returns something the comment schema *does* define. The
// manager dispatches by token name, and an Extension contributes nothing to
// getSchema, so the shims live on the parse list only.
//
// That inverts DOC_IMPORT.md §2's "parse list equals encode list" rule into
// "parse list is a superset that emits only schema nodes" — which is why
// `parseCommentBody` still runs nodeFromJSON on the result afterwards: after
// the conform pass it should throw only on a bug in this file.

function boldAll(nodes: JSONContent[]): JSONContent[] {
  return nodes.map((node) =>
    node.type === "text" ? { ...node, marks: [...(node.marks ?? []), { type: "bold" }] } : node,
  );
}

const commentMarkdownShims = [
  // `# Title` → a bold paragraph. The commenter wanted emphasis on a line; a
  // heading competes with the article's outline (§23b), bold does not.
  Extension.create({
    name: "commentHeadingShim",
    markdownTokenName: "heading",
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
      helpers.createNode("paragraph", undefined, boldAll(helpers.parseInline(token.tokens ?? []))),
  }),
  // A fence → one paragraph of `code`-marked lines joined by hard breaks.
  // Monospace, line structure kept, no codeBlock node needed; adding
  // CodeBlock to §23b is the cheaper fix if this reads badly (§23k).
  Extension.create({
    name: "commentFenceShim",
    markdownTokenName: "code",
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
      const lines = String(token.text ?? "").replace(/\r\n?/g, "\n").split("\n");
      const content: JSONContent[] = [];
      lines.forEach((line, index) => {
        if (index > 0) content.push({ type: "hardBreak" });
        if (line !== "") content.push({ type: "text", text: line, marks: [{ type: "code" }] });
      });
      return helpers.createNode("paragraph", undefined, content);
    },
  }),
  // A table → its raw source, literal, one row per line joined by hard
  // breaks (a newline inside the text would be collapsed below). Not a layout
  // surface a comment has (§23b), and the honest reading of what was typed.
  Extension.create({
    name: "commentTableShim",
    markdownTokenName: "table",
    parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
      const lines = String(token.raw ?? "").replace(/\s+$/, "").replace(/\r\n?/g, "\n").split("\n");
      const content: JSONContent[] = [];
      lines.forEach((line, index) => {
        if (index > 0) content.push({ type: "hardBreak" });
        if (line !== "") content.push({ type: "text", text: line });
      });
      return helpers.createNode("paragraph", undefined, content);
    },
  }),
];

const commentMarkdownManager = new MarkdownManager({
  extensions: [...commentContentExtensions, ...commentMarkdownShims],
});

// A soft line break arrives from marked as a newline *inside* a text node,
// which the editor renders as a break (ProseMirror's `white-space: pre-wrap`)
// and the static renderer collapses — two readings of one stored value. A
// single space is what CommonMark means by it. Code-marked runs are exempt
// only in form: the fence shim above never leaves a newline inside one.
function collapseSoftBreaks(node: JSONContent): JSONContent {
  let out = node;
  if (typeof out.text === "string" && /\r?\n/.test(out.text)) {
    out = { ...out, text: out.text.replace(/\r?\n/g, " ") };
  }
  if (out.content) {
    out = { ...out, content: out.content.map(collapseSoftBreaks) };
  }
  return out;
}

/**
 * Markdown → a comment document over `commentContentExtensions`, ready for
 * `parseCommentBody`. Always a `doc` with at least one block, like the doc
 * importer, and for the same reason. Raw HTML in the source stays literal
 * text (headless, DOC_IMPORT.md §3) — the safe reading of what an anonymous
 * person typed, and the whole reason this runs on the server.
 */
export function markdownToCommentContent(markdown: string): JSONContent {
  const parsed = collapseSoftBreaks(decodeNodeEntities(commentMarkdownManager.parse(markdown)));
  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  return { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] };
}

/**
 * The reverse, for the Markdown edit box (§23m: no second stored form — the
 * stored JSON is serialized back on demand). Runs over the same manager, so
 * a body parsed from Markdown and serialized again re-parses to itself.
 */
export function commentContentToMarkdown(json: JSONContent): string {
  return commentMarkdownManager.serialize(json);
}
