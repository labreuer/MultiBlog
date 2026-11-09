// A list item as Markdown: @tiptap/core's renderNestedMarkdownContent, which
// ListItem's renderMarkdown calls, with two cases it writes as Markdown that
// reads back as something else.
//
//  - **An empty bullet item** is written as its bare marker, `-`. With the
//    package's `- `, the reader takes a list's first item for a paragraph
//    holding "- ".
//  - **A list opening with an empty bullet item, directly under the item's
//    paragraph,** gets a blank line above it. Otherwise `- a` over `  -` reads
//    as a setext heading "a", which CommonMark says it is.
//
// An ordered item keeps its prefix whole, `2. `, since the ordered tokenizer
// (ordered-list-markers.ts) reads it back as an empty item.

import type { JSONContent } from "@tiptap/core";

type Helpers = {
  renderChildren: (nodes: JSONContent[]) => string;
  renderChild?: (node: JSONContent, index: number) => string;
  indent: (text: string) => string;
};

/** `node` as Markdown after `prefix`; with `emptyPrefix`, what an item with no text is written as. */
export function renderListItemMarkdown(node: JSONContent, h: Helpers, prefix: string, emptyPrefix = prefix): string {
  if (!node || !Array.isArray(node.content)) return "";
  const [content, ...children] = node.content;
  const main = h.renderChildren([content]);
  let output = main ? `${prefix}${main}` : emptyPrefix;
  children.forEach((child, index) => {
    const rendered = h.renderChild?.(child, index + 1) ?? h.renderChildren([child]);
    if (rendered === undefined || rendered === null) return;
    const indented = rendered
      .split("\n")
      .map((line) => h.indent(line))
      .join("\n");
    const underlinesText = main !== "" && child.type === "bulletList" && rendered.split("\n", 1)[0] === "-";
    output += child.type === "paragraph" || underlinesText ? `\n\n${indented}` : `\n${indented}`;
  });
  return output;
}
