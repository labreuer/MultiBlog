// Markdown -> TipTap JSON for /docs' Markdown import, server-side and headless.
// Why MarkdownManager rather than an Editor, what raw HTML in the source turns
// into, and the reasoning behind the title rule below: docs/DOC_IMPORT.md.

import { MarkdownManager } from "@tiptap/markdown";
import { decodeHTML } from "entities";
import type { JSONContent } from "@tiptap/core";
import { contentExtensions } from "./tiptap-schema";

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
function decodeNodeEntities(node: JSONContent): JSONContent {
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
