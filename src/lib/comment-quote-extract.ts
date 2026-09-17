import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { quotedTextAt } from "./comment-quote-match";

// PLAN.md §23n — which spans of a comment body are quotations to be found,
// and §23f — how the body is rewritten once they are. Pure and browser-safe;
// the server-side capture (comment-quote-capture.ts) is what loads targets
// and runs the matcher between the two halves here.
//
// **Extraction.** Every *outermost* blockquote is a block candidate (an
// anchored quote never nests inside another — the attribute form's one
// structural rule, kept here rather than in a content expression, §23f).
// Inline candidates are runs inside straight or curly double quotes within
// one textblock outside any blockquote, not crossing a hard break, not under
// the `code` mark, and at least MIN_INLINE_QUOTE_CHARS long so a quoted "yes"
// is not hunted through the post. A span already carrying a `quote` mark or
// an `anchorId` is a candidate too — on edit, and for the rich composer's
// placeholders — with that id reported so the capture can hint from it.
//
// **Rewrite.** A matched block gets one plain paragraph per source textblock
// in the range and its `anchorId`; a matched inline run becomes the derived
// text under the `quote` mark, its typed quote characters dropped since <q>
// supplies its own. An unmatched candidate degrades: the blockquote keeps a
// null `anchorId`, an existing mark comes off and the words stay between
// literal quotes. Never an error.

/** The shortest inline run worth matching, in normalized characters. */
export const MIN_INLINE_QUOTE_CHARS = 12;

export type BlockQuoteCandidate = {
  kind: "block";
  /** The blockquote node's position. */
  pos: number;
  nodeSize: number;
  /** Its textblocks joined by newlines — what the matcher searches for. */
  text: string;
  anchorId: string | null;
};

export type InlineQuoteCandidate = {
  kind: "inline";
  /** The quoted words, excluding any surrounding quote characters. */
  from: number;
  to: number;
  text: string;
  anchorId: string | null;
  /** True when the run is delimited by typed quote characters at from-1 and to. */
  typedQuotes: boolean;
};

export type QuoteCandidateSpan = BlockQuoteCandidate | InlineQuoteCandidate;

const OPEN_QUOTES = new Set(['"', "\u201c"]);
const CLOSE_QUOTES = new Set(['"', "\u201d"]);

/** One textblock's inline content as a string, with each character's position and what it may take part in. */
function scanTextblock(block: PMNode, blockPos: number) {
  const chars: string[] = [];
  const positions: number[] = [];
  const eligible: boolean[] = [];
  const quoteAnchorIds: (string | null | undefined)[] = [];
  block.forEach((child, offset) => {
    const start = blockPos + 1 + offset;
    if (child.isText && child.text) {
      const code = child.marks.some((m) => m.type.name === "code");
      const quote = child.marks.find((m) => m.type.name === "quote");
      for (let i = 0; i < child.text.length; i++) {
        chars.push(child.text[i]);
        positions.push(start + i);
        eligible.push(!code && !quote);
        quoteAnchorIds.push(quote ? ((quote.attrs.anchorId as string | null) ?? null) : undefined);
      }
    } else {
      chars.push("\n");
      positions.push(start);
      eligible.push(false);
      quoteAnchorIds.push(undefined);
    }
  });
  return { chars, positions, eligible, quoteAnchorIds };
}

export function extractQuoteCandidates(doc: PMNode): QuoteCandidateSpan[] {
  const found: QuoteCandidateSpan[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockquote") {
      found.push({
        kind: "block",
        pos,
        nodeSize: node.nodeSize,
        text: node.textBetween(0, node.content.size, "\n", "\n"),
        anchorId: typeof node.attrs.anchorId === "string" ? node.attrs.anchorId : null,
      });
      return false;
    }
    if (!node.isTextblock) return true;

    const scan = scanTextblock(node, pos);

    // Existing `quote` marks: one candidate per run of the same anchor id.
    let runStart = -1;
    for (let i = 0; i <= scan.chars.length; i++) {
      const id = i < scan.chars.length ? scan.quoteAnchorIds[i] : undefined;
      const prev = i > 0 ? scan.quoteAnchorIds[i - 1] : undefined;
      const inRun = id !== undefined;
      const prevInRun = prev !== undefined;
      if (inRun && (!prevInRun || id !== prev)) runStart = i;
      if (prevInRun && (!inRun || id !== prev)) {
        const from = scan.positions[runStart];
        const to = scan.positions[i - 1] + 1;
        const text = scan.chars.slice(runStart, i).join("");
        if (text.trim()) found.push({ kind: "inline", from, to, text, anchorId: prev ?? null, typedQuotes: false });
        runStart = -1;
      }
    }

    // Typed quotes: an opening quote, at least MIN eligible characters with
    // no quote or break inside, a closing quote.
    const text = scan.chars.map((c, i) => (scan.eligible[i] ? c : "\u0000")).join("");
    const re = /["\u201c]([^"\u201c\u201d\n\u0000]+)["\u201d]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const inner = match[1];
      if (inner.trim().length < MIN_INLINE_QUOTE_CHARS) continue;
      const innerStart = match.index + 1;
      const innerEnd = innerStart + inner.length;
      const openChar = scan.chars[match.index];
      const closeChar = scan.chars[innerEnd];
      if (!OPEN_QUOTES.has(openChar) || !CLOSE_QUOTES.has(closeChar)) continue;
      found.push({
        kind: "inline",
        from: scan.positions[innerStart],
        to: scan.positions[innerEnd - 1] + 1,
        text: inner,
        anchorId: null,
        typedQuotes: true,
      });
    }
    return false;
  });
  return found;
}

export type QuoteResolution =
  | {
      candidate: QuoteCandidateSpan;
      /** The real anchor row id the body will carry. */
      anchorId: string;
      /** `quotedTextAt` the verified range — what an inline run becomes, and the row's `quoted_text`. */
      quotedText: string;
      /**
       * What a block becomes: one plain paragraph per source textblock in the
       * range (`paragraphTextsIn`), or a single paragraph of the quoted text
       * for a source with no ProseMirror structure — a PDF page.
       */
      paragraphs: string[];
    }
  | { candidate: QuoteCandidateSpan; anchorId: null };

function candidateStart(candidate: QuoteCandidateSpan): number {
  return candidate.kind === "block" ? candidate.pos : candidate.from;
}

/** The plain paragraphs a matched range of `source` becomes inside the quoting comment. */
export function paragraphTextsIn(source: PMNode, from: number, to: number): string[] {
  const texts: string[] = [];
  source.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + 1 + node.content.size);
    if (end > start) {
      const text = quotedTextAt(source, start, end);
      if (text.trim()) texts.push(text);
    }
    return false;
  });
  return texts;
}

/**
 * Rewrites `doc` per the resolutions (§23f) and returns the new document.
 * Applied last-position-first so earlier positions stay valid; every
 * resolution's candidate must come from `extractQuoteCandidates(doc)`.
 */
export function applyQuoteResolutions(doc: PMNode, resolutions: QuoteResolution[]): PMNode {
  const schema = doc.type.schema;
  const tr = new Transform(doc);
  const ordered = [...resolutions].sort((a, b) => candidateStart(b.candidate) - candidateStart(a.candidate));

  for (const resolution of ordered) {
    const { candidate } = resolution;
    if (candidate.kind === "block") {
      if (resolution.anchorId === null) {
        if (candidate.anchorId !== null) {
          const node = tr.doc.nodeAt(candidate.pos);
          if (node) tr.setNodeMarkup(candidate.pos, undefined, { ...node.attrs, anchorId: null });
        }
        continue;
      }
      const texts = resolution.paragraphs.filter((text) => text.trim());
      const paragraphs = (texts.length > 0 ? texts : [resolution.quotedText]).map((text) =>
        schema.nodes.paragraph.create(null, schema.text(text)),
      );
      const blockquote = schema.nodes.blockquote.create({ anchorId: resolution.anchorId }, paragraphs);
      tr.replaceWith(candidate.pos, candidate.pos + candidate.nodeSize, blockquote);
      continue;
    }

    // Inline.
    const quoteMark = schema.marks.quote;
    if (resolution.anchorId === null) {
      if (candidate.anchorId !== null) {
        // The mark comes off and the words stay between literal quotes, since
        // <q> was what drew them before.
        tr.removeMark(candidate.from, candidate.to, quoteMark);
        tr.insert(candidate.to, schema.text('"'));
        tr.insert(candidate.from, schema.text('"'));
      }
      continue;
    }
    const from = candidate.typedQuotes ? candidate.from - 1 : candidate.from;
    const to = candidate.typedQuotes ? candidate.to + 1 : candidate.to;
    tr.replaceWith(from, to, schema.text(resolution.quotedText, [quoteMark.create({ anchorId: resolution.anchorId })]));
  }

  return tr.doc;
}

/**
 * Every anchor id the rewritten body still carries that is not in
 * `assigned` — a placeholder the composer left in a nested blockquote, a
 * stale id from an earlier revision — is cleared, so the stored body never
 * names a row that does not exist. JSON in, JSON out.
 */
export function clearUnassignedAnchorIds(json: JSONContent, assigned: Set<string>): JSONContent {
  let out = json;
  const stale = (attrs: Record<string, unknown> | undefined) =>
    typeof attrs?.anchorId === "string" && !assigned.has(attrs.anchorId);
  if (out.type === "blockquote" && stale(out.attrs)) {
    out = { ...out, attrs: { ...out.attrs, anchorId: null } };
  }
  if (out.marks?.some((m) => m.type === "quote" && stale(m.attrs))) {
    out = { ...out, marks: out.marks.filter((m) => !(m.type === "quote" && stale(m.attrs))) };
  }
  if (out.content) {
    out = { ...out, content: out.content.map((child) => clearUnassignedAnchorIds(child, assigned)) };
  }
  return out;
}
