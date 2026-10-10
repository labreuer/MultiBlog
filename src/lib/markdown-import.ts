// Markdown -> TipTap JSON for /docs' Markdown import, server-side and headless.
// Why MarkdownManager rather than an Editor, what raw HTML in the source turns
// into, and the reasoning behind the title rule below: docs/DOC_IMPORT.md.

import { MarkdownManager } from "@tiptap/markdown";
import { decodeHTML } from "entities";
import { Extension, type JSONContent, type MarkdownParseHelpers, type MarkdownToken } from "@tiptap/core";
import {
  annotationContentExtensions,
  commentContentExtensions,
  contentExtensions,
  pmAnnotationContentSchema,
  pmSchema,
  stripMarksFromDoc,
} from "./tiptap-schema";
import { blockText } from "./doc-text";

// contentExtensions, and specifically the same exported value the caller
// encodes the ydoc with — a node type registered here but missing there is
// dropped silently on encode rather than reported (docs/DOC_IMPORT.md §2).
const markdownManager = new MarkdownManager({ extensions: contentExtensions });

// The import limit. MUST stay under Next's own server-action body limit (1 MB
// by default, not overridden in next.config.ts), which /docs' import action
// sits behind. That limit is enforced while the body is still being read, so a
// payload above it never reaches the action and fails with an unstyled 413
// instead: a cap at or above 1 MB is a message that never prints. Raise it
// only alongside `serverActions.bodySizeLimit`, never past it — docs/DOC_IMPORT.md
// §6. scripts/import-claude-chats.ts applies it too, though nothing limits its
// input, so it creates no doc /docs couldn't (docs/CLAUDE_IMPORT.md §3).
export const MAX_MARKDOWN_BYTES = 768 * 1024;

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

// ---------------------------------------------------------------------------
// docs/MCP.md §6 — the other direction, for the MCP server's reads: a doc's
// body as Markdown, over the same manager, so a body parsed from Markdown and
// serialized again re-parses to itself, tables included (GFM). A merged cell
// and a column's width have no Markdown form and are lost here; the export's
// JSON keeps them.

/**
 * `json` with each run of inline code numbered (`attrs.run`) afresh wherever
 * the other marks on it change, so the serializer closes the code span there
 * and opens another. Inline code may carry any other mark (docs/TIPTAP.md,
 * "Inline code takes other marks"), so part of a span can be bold. As one
 * span, the bold's `**` would land inside the backticks, where Markdown reads
 * it as literal text, and a round trip would write the asterisks into the
 * code. Split, `wf_1234` with `wf` bold is `` **`wf`**`_1234` ``, which parses
 * back to what it was. Two spans never touch: the marks they differ by open
 * or close between them, outside the backticks, because code is the innermost
 * mark (StarterKit, tiptap-schema.ts). The split relies on @tiptap/markdown
 * treating two marks of one type with different attributes as two marks.
 * Nothing reads the number: the parse makes a plain code mark. The
 * `markdown-inline-code` tests pin all of this.
 */
function splitCodeAtFormatting(json: JSONContent): JSONContent {
  if (!json.content) return json;
  let run = 0;
  let previous: string | null = null;
  const content = json.content.map((child) => {
    const code = child.type === "text" ? child.marks?.find((mark) => mark.type === "code") : undefined;
    if (!code) {
      previous = null;
      return splitCodeAtFormatting(child);
    }
    const others = child
      .marks!.filter((mark) => mark !== code)
      .map((mark) => JSON.stringify(mark))
      .sort()
      .join();
    if (others !== previous) run += 1;
    previous = others;
    return { ...child, marks: child.marks!.map((mark) => (mark === code ? { ...mark, attrs: { ...mark.attrs, run } } : mark)) };
  });
  return { ...json, content };
}

/**
 * A doc body (docContentExtensions JSON) as Markdown. The `annotation` and
 * `authorHighlight` marks are stripped first: neither has a Markdown form,
 * and `contentExtensions` would refuse both.
 */
export function docContentToMarkdown(json: JSONContent): string {
  return markdownManager.serialize(splitCodeAtFormatting(stripMarksFromDoc(json, ["annotation", "authorHighlight"])));
}

/**
 * Markdown as top-level blocks over `contentExtensions`, with no title taken
 * from a leading heading — what an edit writes into a doc (docs/MCP.md §6),
 * where `## Results` means a heading in the body. Entities are decoded as for
 * an import; the caller validates against the schema.
 */
export function markdownToBlocks(markdown: string): JSONContent[] {
  const parsed = decodeNodeEntities(markdownManager.parse(markdown));
  return Array.isArray(parsed.content) && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }];
}

/**
 * Markdown as the text a doc made from it would hold (doc-text.ts's text
 * form), with no title taken from a leading heading — the quote matcher's
 * one retry (docs/MCP.md §7), so `the **key** claim` or a quote with a link
 * in it, copied out of a Markdown read, still lands.
 */
export function markdownToText(markdown: string): string {
  const parsed = decodeNodeEntities(markdownManager.parse(markdown));
  const blocks = Array.isArray(parsed.content) && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }];
  try {
    return blockText(pmSchema.nodeFromJSON({ type: "doc", content: blocks }));
  } catch {
    return plainText(parsed);
  }
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
  return commentMarkdownManager.serialize(splitCodeAtFormatting(json));
}

// ---------------------------------------------------------------------------
// docs/MCP.md §9 — an annotation body, both ways, for the MCP server: read as
// Markdown, and written from it.
//
// The parse list is the comment's arrangement (§23m above): the schema is
// `annotationContentExtensions` — StarterKit and the author mark, no tables —
// and a table, which the manager's fallback would silently delete, is caught
// by the comment's table shim and kept as its literal source. A heading and a
// fence need no shim here: StarterKit has both.

const annotationMarkdownManager = new MarkdownManager({
  extensions: [...annotationContentExtensions, commentMarkdownShims[2]],
});

/** An annotation body (annotationContentExtensions JSON) as Markdown, the author mark stripped. */
export function annotationContentToMarkdown(json: JSONContent): string {
  return annotationMarkdownManager.serialize(splitCodeAtFormatting(stripMarksFromDoc(json, ["authorHighlight"])));
}

/**
 * Markdown → an annotation body over `annotationContentExtensions`, checked
 * against its schema: entities decoded and soft breaks collapsed as a
 * comment's are, and always a `doc` with at least one block. Throws when the
 * result isn't a valid body, which the caller answers as `invalid`.
 */
export function markdownToAnnotationContent(markdown: string): JSONContent {
  const parsed = collapseSoftBreaks(decodeNodeEntities(annotationMarkdownManager.parse(markdown)));
  const blocks = Array.isArray(parsed.content) && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }];
  const json: JSONContent = { type: "doc", content: blocks };
  pmAnnotationContentSchema.nodeFromJSON(json).check();
  return json;
}
