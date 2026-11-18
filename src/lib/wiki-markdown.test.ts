import { test } from "node:test";
import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import {
  annotationContentToMarkdown,
  commentContentToMarkdown,
  docContentToMarkdown,
  markdownToAnnotationContent,
  markdownToBlocks,
  markdownToCommentContent,
} from "./markdown-import";
import { pmAnnotationContentSchema, pmCommentContentSchema, pmDocContentSchema } from "./tiptap-schema";
import { wikiPagePath, type WikiAddress } from "./wiki-address";

// docs/WIKI.md "What a name may hold" — why a name's parentheses must be
// balanced: a Markdown link takes balanced parentheses only, and the
// exporters, which MCP reads and writes go through, write a URL as it is. A
// link to every kind of name the rules accept reads back with its address
// whole, through each exporter and its parse.

const commons = { kind: "commons" } as const;
const addresses: WikiAddress[] = [
  { owner: commons, name: "Mercury (planet)", variant: "" },
  { owner: commons, name: "(a) (b (c))", variant: "2" },
  { owner: { kind: "person", slug: "jane-doe" }, name: "R&D (lab)", variant: "" },
  { owner: commons, name: "100% pure", variant: "" },
  { owner: commons, name: "Café :: a=b, c+d; e$ f*g! h'i", variant: "x-y" },
];

const exporters: [string, Schema, (json: JSONContent) => string, (markdown: string) => JSONContent][] = [
  ["doc", pmDocContentSchema, docContentToMarkdown, (md) => ({ type: "doc", content: markdownToBlocks(md) })],
  ["comment", pmCommentContentSchema, commentContentToMarkdown, markdownToCommentContent],
  ["annotation", pmAnnotationContentSchema, annotationContentToMarkdown, markdownToAnnotationContent],
];

for (const [kind, schema, toMarkdown, fromMarkdown] of exporters) {
  test(`${kind}: a link to a wiki page reads back with its address whole, relative and absolute`, () => {
    for (const address of addresses) {
      for (const href of [wikiPagePath(address), `https://example.com${wikiPagePath(address)}`]) {
        const content = [
          { type: "text", text: "See " },
          { type: "text", text: address.name, marks: [{ type: "link", attrs: { href } }] },
          { type: "text", text: " (and more)." },
        ];
        const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content }] });
        const markdown = toMarkdown(doc.toJSON());
        const back = schema.nodeFromJSON(fromMarkdown(markdown));
        const hrefs: string[] = [];
        back.descendants((node) => {
          for (const mark of node.marks) if (mark.type.name === "link") hrefs.push(mark.attrs.href as string);
        });
        assert.deepEqual(hrefs, [href], `${JSON.stringify(markdown)} read back as ${JSON.stringify(back.toJSON())}`);
        assert.equal(back.textContent, doc.textContent, JSON.stringify(markdown));
      }
    }
  });
}
