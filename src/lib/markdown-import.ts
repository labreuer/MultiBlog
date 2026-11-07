// Markdown -> TipTap JSON for /docs' Markdown import, server-side and headless.
// Why MarkdownManager rather than an Editor, what raw HTML in the source turns
// into, and the reasoning behind the title rule below: docs/DOC_IMPORT.md.

import { MarkdownManager } from "@tiptap/markdown";
import { decodeHTML } from "entities";
import { Marked, marked } from "marked";
import { Extension, type JSONContent, type MarkdownParseHelpers, type MarkdownToken } from "@tiptap/core";
import {
  annotationContentExtensions,
  commentContentExtensions,
  contentExtensions,
  Link,
  pmAnnotationContentSchema,
  pmSchema,
  StarterKit,
  stripMarksFromDoc,
  tableExtensions,
} from "./tiptap-schema";
import { blockText } from "./doc-text";
import { CITATION } from "./entity-chips/kinds/citation";
import { citationShapedAts, citationStart, guardBareKey, readCitation } from "./entity-chips/kinds/citation-markdown";
import { MENTION, MENTION_HREF_PREFIX } from "./entity-chips/kinds/mention";
import { EntityChip } from "./entity-chips/node";
import { isChip } from "./entity-chips/text";
import { ENTITY_CHIP } from "./entity-chips/types";

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
  // A chip placeholder (below) reads as the words its Markdown showed: a
  // title is plain text, and a mention in the heading it is taken from would
  // otherwise leave a gap.
  if (isChip(node)) {
    const label = (node.attrs?.data as Record<string, unknown> | undefined)?.label;
    return typeof label === "string" ? label : "";
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

// ---------------------------------------------------------------------------
// docs/ENTITY_CHIPS.md, MCP items 1 and 2 — a doc's own Markdown: what
// `contentExtensions` writes, plus entity chips.
//
// A chip is written in its chip kind's syntax, which is computed before the
// serializer runs (`chipMarkdowns`, from the doc-order pass the labels come
// from) and handed over on the node as `md`: the serializer meets one node at
// a time and has no chip context.
//
// The writer escapes what would otherwise read back as a chip, so the
// lowering stays one-to-one: nothing in a doc's text reads back as a chip
// that wasn't one.
//
// - A mention's syntax is a link, `[@Label](/authors/slug)`, so a link
//   someone wrote by hand with that shape is written with its `@` escaped,
//   `[\@Andrew](/authors/andrew)`, which CommonMark reads as the same link
//   text.
// - A citation's is Pandoc's, so text reading `@radner2012` is written
//   `\@radner2012` (`citationShapedAts`), and hand-written `[@radner2012]`
//   comes out as `\[\@radner2012\]`, the serializer escaping the brackets.
// - Text beside a citation can't change it (docs/CITATIONS.md, "Text beside a
//   chip"): a `(` or `:` straight after a bracketed chip is escaped, since
//   `[@radner2012](sic)` reads as a link and `[@radner2012]: agreed.` opening
//   a paragraph as a link reference definition, and a bare key is braced
//   where a letter or digit before it, or key characters after it, would
//   change it (`guardBareKey`).
//
// The serializer has no hook for any of this: a mark's `renderMarkdown` is
// asked for its opening and closing around a placeholder and never sees the
// text, and the methods that escape a text node are private and see no
// sibling. So a stand-in is put wherever a backslash belongs before the
// serializer runs, and replaced with one in what it wrote. The stand-in is a
// private-use character the doc doesn't hold, checked per doc, since
// extracted PDF text can hold any.

/** Whether `node`, child `index` of `parent`, is the text a mention-shaped link opens with. */
function opensMentionShapedLink(node: JSONContent, parent: JSONContent | undefined, index: number): boolean {
  if (node.type !== "text" || !node.text?.startsWith("@")) return false;
  const marks = node.marks ?? [];
  const href = marks.find((mark) => mark.type === "link")?.attrs?.href;
  if (typeof href !== "string" || !href.startsWith(MENTION_HREF_PREFIX)) return false;
  // Only the link's first text: the parse reads a mention off how the link's text starts.
  const previous = index > 0 ? parent?.content?.[index - 1] : undefined;
  return !previous?.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === href);
}

/** A chip's Markdown, as `withChipMarkdown` put it on the node; "" for anything else. */
function chipMd(node: JSONContent | undefined): string {
  return node && isChip(node) && typeof node.attrs?.md === "string" ? node.attrs.md : "";
}

/** What a neighbour of a chip reads as, for the chip's guards: its text, or its own Markdown. */
function neighbourText(node: JSONContent | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  return chipMd(node);
}

/** `json` serialized by `manager`, with a backslash wherever its text alone would read back as something else (above). */
function serializeWithEscapes(manager: MarkdownManager, json: JSONContent): string {
  const source = JSON.stringify(json);
  let code = 0xe000;
  while (source.includes(String.fromCharCode(code))) code += 1;
  const slash = String.fromCharCode(code);
  let found = false;

  const visit = (node: JSONContent): JSONContent => {
    // Inside code a backslash is literal, and so is everything it would escape.
    if (node.type === "codeBlock" || !node.content) return node;
    const siblings = node.content;
    const content = siblings.map((child, index): JSONContent => {
      const previous = siblings[index - 1];
      if (isChip(child)) {
        const md = chipMd(child);
        const guarded = md && guardBareKey(md, neighbourText(previous).slice(-1) || undefined, neighbourText(siblings[index + 1]));
        return guarded && guarded !== md ? { ...child, attrs: { ...child.attrs, md: guarded } } : child;
      }
      if (child.type !== "text" || typeof child.text !== "string") return visit(child);
      if (child.marks?.some((mark) => mark.type === "code")) return child;
      // Link text holds no citation, so only a mention's shape is escaped there.
      const inLink = child.marks?.some((mark) => mark.type === "link") ?? false;
      const offsets = new Set(inLink ? [] : citationShapedAts(child.text));
      if (opensMentionShapedLink(child, node, index)) offsets.add(0);
      if (/^[:(]/.test(child.text) && chipMd(previous).endsWith("]")) offsets.add(0);
      if (offsets.size === 0) return child;
      found = true;
      let text = "";
      let done = 0;
      for (const offset of [...offsets].sort((a, b) => a - b)) {
        text += child.text.slice(done, offset) + slash;
        done = offset;
      }
      return { ...child, text: text + child.text.slice(done) };
    });
    return { ...node, content };
  };

  const markdown = manager.serialize(visit(json));
  return found ? markdown.replaceAll(slash, "\\") : markdown;
}

const ChipMarkdown = EntityChip.extend({
  renderMarkdown: (node) => (typeof node.attrs?.md === "string" ? node.attrs.md : ""),
});

const docMarkdownManager = new MarkdownManager({ extensions: [...contentExtensions, ChipMarkdown] });

// The other direction (MCP item 2): Markdown read with each chip kind's
// syntax taken for a chip. Only the paths that ask for it parse this way
// (MCP's doc and note writes, /docs' Markdown import, and a quote's chip
// form, `withQuoteChips`); a comment and a post never do, so `[@x](/authors/x)`
// pasted into a comment stays the link it says it is.
//
// The parse keys on the syntax, never on the label: a link to an author page
// whose text opens with a literal `@`. marked tells that `@` from an escaped
// one by the link's first token, `text` against `escape`, which is what makes
// the writer's `[\@…]` a plain link on the way back.
//
// What comes out is a **placeholder**, a chip holding the slug the Markdown
// named and no instance id. A slug is not an identity: the caller resolves
// each to an account, under the chip kind's own rule for who may be named
// (`resolveParsedChips`), before anything is stored.
//
// A citation is Pandoc's syntax (citation-markdown.ts), read by a tokenizer
// of its own into the same kind of placeholder, holding the keys it named.
//
// The link is replaced where StarterKit's own stands, since a mark's place in
// the list is its rank (tiptap-schema.ts), and the first handler registered
// for a token is the one the parser uses.

const CITATION_TOKEN = "citation";

/**
 * `tokens` with each citation put back as the text it was read from. Link
 * text holds no citation (docs/CITATIONS.md, "Markdown"): a chip can't carry
 * a link, so a citation there would cost the link, and
 * `[@handle](https://x.com/handle)` is a link, not an unknown key.
 */
function citationsAsText(tokens: readonly MarkdownToken[] | undefined): MarkdownToken[] {
  return (tokens ?? []).map((token) =>
    token.type === CITATION_TOKEN
      ? { type: "text", raw: token.raw, text: token.raw }
      : token.tokens
        ? { ...token, tokens: citationsAsText(token.tokens) }
        : token,
  );
}

const CitationParsing = Extension.create({
  name: "citationParsing",
  markdownTokenName: CITATION_TOKEN,
  markdownTokenizer: {
    name: CITATION_TOKEN,
    level: "inline",
    start: citationStart,
    tokenize: (src, tokens) => {
      const before = tokens[tokens.length - 1]?.raw?.slice(-1);
      const citation = readCitation(src, before || undefined);
      return citation ? { type: CITATION_TOKEN, raw: citation.raw, citation } : undefined;
    },
  },
  parseMarkdown: (token) => {
    const citation = token.citation as ReturnType<typeof readCitation>;
    if (!citation) return [];
    return {
      type: ENTITY_CHIP,
      attrs: {
        kind: CITATION,
        iid: "",
        // `label` is the Markdown it was read from, for a title taken from a heading.
        data: { items: citation.items, ...(citation.narrative ? { form: "narrative" } : {}), label: citation.raw },
      },
    };
  },
});

const ChipParsingLink = Link.extend({
  parseMarkdown: (token, helpers) => {
    const href = typeof token.href === "string" ? token.href : "";
    token = { ...token, tokens: citationsAsText(token.tokens) };
    const first = token.tokens?.[0];
    if (href.startsWith(MENTION_HREF_PREFIX) && first?.type === "text" && String(first.raw ?? "").startsWith("@")) {
      const slug = href.slice(MENTION_HREF_PREFIX.length);
      // The label rides along for the one reader that wants it: an import
      // that leaves an unresolvable mention as the link it also is.
      if (/^[^/?#\s]+$/.test(slug)) {
        const label = helpers.parseInline(token.tokens || []).map(plainText).join("");
        return { type: ENTITY_CHIP, attrs: { kind: MENTION, iid: "", data: { slug, label } } };
      }
    }
    // No title: Markdown's `[text](url "title")` would store one as an
    // attribute, which a read can't show and the merge would then see as a
    // link that changed (docs/ENTITY_CHIPS.md, MCP item 5).
    return helpers.applyMark("link", helpers.parseInline(token.tokens || []), { href: token.href });
  },
});

const ChipParsingKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => (extension.name === "link" ? ChipParsingLink : extension));
  },
});

// Each chip parser has a marked instance of its own: a tokenizer is
// registered on the instance, and on the shared one the citation's would also
// run in the comment parse, which has no chip node and would drop "@Andrew".
const chipMarked = () => new Marked() as unknown as typeof marked;

const docChipParser = new MarkdownManager({ marked: chipMarked(), extensions: [ChipParsingKit, CitationParsing, ...tableExtensions] });

/**
 * `json` with no mark starting or ending in whitespace against a chip. A chip
 * carries no mark (y-tiptap keeps none on an inline node), so in
 * `**see [@k]**` the bold stops at the chip with the space still inside it.
 * The writer puts whitespace outside a mark at every edge, `**see** [@k]`,
 * so the parse does the same, and a doc made from Markdown is the doc its own
 * Markdown reads back as.
 */
function spacesBesideChipsUnmarked(json: JSONContent): JSONContent {
  if (!json.content) return json;
  const content = json.content.map(spacesBesideChipsUnmarked);
  if (!content.some((node) => isChip(node))) return { ...json, content };
  const out: JSONContent[] = [];
  content.forEach((node, index) => {
    if (node.type !== "text" || typeof node.text !== "string" || !node.marks?.length) {
      out.push(node);
      return;
    }
    const lead = isChip(content[index - 1]) ? /^\s*/.exec(node.text)![0] : "";
    const rest = node.text.slice(lead.length);
    const trail = isChip(content[index + 1]) ? /\s*$/.exec(rest)![0] : "";
    const core = rest.slice(0, rest.length - trail.length);
    if (lead) out.push({ type: "text", text: lead });
    if (core) out.push({ ...node, text: core });
    if (trail) out.push({ type: "text", text: trail });
  });
  return { ...json, content: out };
}

/** `markdown` read by a chip parser: placeholders the caller resolves (`resolveParsedChips`). */
function parseWithChips(manager: MarkdownManager, markdown: string): JSONContent {
  return spacesBesideChipsUnmarked(decodeNodeEntities(manager.parse(markdown)));
}

// What `escapeChipAts` leaves alone, then the `@`s it escapes. Nothing reads a
// chip in a code span, an autolink or a bare URL, and a backslash there would
// show, or change the URL. A code span closes on a run of as many backticks
// and can cross a line break, though not a blank line. An escape is passed
// over whole, so `\@` stays one.
const CHIP_AT =
  /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[^])*?(?<!`)\1(?!`)|<[a-z][a-z0-9+.-]*:[^\s<>]*>|(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]*|\\[^]|@(?=\{)|(?<![\p{L}\p{N}])@(?=[\p{L}\p{N}_])/giu;

/**
 * `markdown` with every `@` the chip parse could read as a chip escaped, for
 * Markdown whose text stays text whatever it holds: a chat transcript names
 * packages (`@playwright/test`) and people, not works or accounts. Every
 * chip kind's syntax needs an `@` (a mention's link text opens with one), so
 * escaping those is enough. An `@` straight after a letter or digit, as in an
 * address, is left as it is unless a brace follows it, since only a braced key
 * is read there (docs/CITATIONS.md, "Markdown").
 *
 * It doesn't know where a fenced code block is: the caller skips those.
 */
export function escapeChipAts(markdown: string): string {
  return markdown.replace(CHIP_AT, (match) => (match === "@" ? "\\@" : match));
}

/** `json` with each chip carrying its Markdown as `md`, for `ChipMarkdown` to write. */
function withChipMarkdown(json: JSONContent, chipMarkdown: ReadonlyMap<string, string>): JSONContent {
  if (isChip(json)) {
    const md = typeof json.attrs?.iid === "string" ? chipMarkdown.get(json.attrs.iid) : undefined;
    return md === undefined ? json : { ...json, attrs: { ...json.attrs, md } };
  }
  return json.content ? { ...json, content: json.content.map((child) => withChipMarkdown(child, chipMarkdown)) } : json;
}

/**
 * A doc body (docContentExtensions JSON) as Markdown. The `annotation` and
 * `authorHighlight` marks are stripped first: neither has a Markdown form.
 *
 * `chipMarkdown` is each entity chip's Markdown by instance id
 * (`chipMarkdowns`, over the whole doc, even when `json` is one block of it:
 * a label can depend on the chips around it). A chip it has no entry for is
 * left out.
 */
export function docContentToMarkdown(json: JSONContent, chipMarkdown?: ReadonlyMap<string, string>): string {
  const stripped = stripMarksFromDoc(json, ["annotation", "authorHighlight"]);
  return serializeWithEscapes(
    docMarkdownManager,
    splitCodeAtFormatting(chipMarkdown ? withChipMarkdown(stripped, chipMarkdown) : stripped),
  );
}

/**
 * A published post's content (contentExtensions JSON) as Markdown. A post
 * holds no chip, but its text is escaped as a doc's is, so it can be sent to
 * `create_doc` as it reads: a mention's label at publish, "@Ada Lovelace", is
 * text that would otherwise read back as a citation.
 */
export function postContentToMarkdown(json: JSONContent): string {
  return serializeWithEscapes(markdownManager, splitCodeAtFormatting(json));
}

/**
 * Markdown as top-level blocks over `contentExtensions`, with no title taken
 * from a leading heading — what an edit writes into a doc (docs/MCP.md §6),
 * where `## Results` means a heading in the body. Entities are decoded as for
 * an import; the caller validates against the schema.
 */
export function markdownToBlocks(markdown: string, opts: { chips?: boolean } = {}): JSONContent[] {
  // With `chips`, each chip kind's syntax becomes a chip placeholder (above),
  // which the caller must resolve before storing anything.
  const parsed = opts.chips ? parseWithChips(docChipParser, markdown) : decodeNodeEntities(markdownManager.parse(markdown));
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

export function markdownToDocContent(markdown: string, opts: { chips?: boolean } = {}): MarkdownImport {
  // With `chips`, as `markdownToBlocks`: placeholders the caller resolves.
  const parsed = opts.chips ? parseWithChips(docChipParser, markdown) : decodeNodeEntities(markdownManager.parse(markdown));
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

const annotationChipParser = new MarkdownManager({
  marked: chipMarked(),
  extensions: [ChipParsingKit, CitationParsing, commentMarkdownShims[2]],
});

// The writer: the same list with the doc writer's chip and its escape
// (above), which a note's body shares with a doc's.
const annotationMarkdownWriter = new MarkdownManager({
  extensions: [...annotationContentExtensions, ChipMarkdown, commentMarkdownShims[2]],
});

/**
 * An annotation body (annotationContentExtensions JSON) as Markdown, the
 * author mark stripped. `chipMarkdown` is each of its entity chips' Markdown
 * by instance id, as for `docContentToMarkdown`; a body is its own document
 * to that pass.
 */
export function annotationContentToMarkdown(json: JSONContent, chipMarkdown?: ReadonlyMap<string, string>): string {
  const stripped = stripMarksFromDoc(json, ["authorHighlight"]);
  return serializeWithEscapes(
    annotationMarkdownWriter,
    splitCodeAtFormatting(chipMarkdown ? withChipMarkdown(stripped, chipMarkdown) : stripped),
  );
}

/**
 * Markdown → an annotation body over `annotationContentExtensions`, checked
 * against its schema: entities decoded and soft breaks collapsed as a
 * comment's are, and always a `doc` with at least one block. Throws when the
 * result isn't a valid body, which the caller answers as `invalid`.
 */
export function markdownToAnnotationContent(markdown: string, opts: { chips?: boolean } = {}): JSONContent {
  // With `chips`, as `markdownToBlocks`: placeholders the caller resolves.
  const parsed = collapseSoftBreaks(
    opts.chips ? parseWithChips(annotationChipParser, markdown) : decodeNodeEntities(annotationMarkdownManager.parse(markdown)),
  );
  const blocks = Array.isArray(parsed.content) && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }];
  const json: JSONContent = { type: "doc", content: blocks };
  pmAnnotationContentSchema.nodeFromJSON(json).check();
  return json;
}
