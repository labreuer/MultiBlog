import { Fragment, Mark, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import type { JSONContent } from "@tiptap/core";
import { diffText, tokenizeFine } from "./diff";
import { alignBlocks } from "./block-align";
import { blockText, blocksOfRange, docBlocks, findHeading, sectionOf, type DocBlock } from "./doc-text";
import { flattenForMatch, normalizeForMatch, quotedTextAt, type FlatTarget } from "./comment-quote-match";
import { contextOf, resolveQuote, type QuoteSpec } from "./quote-resolve";

// docs/MCP.md §6 — a targeted edit of a doc: what it means to change, and
// nothing else. Pure, over ProseMirror nodes, so the collab server's edit
// endpoint (server/ydoc-hooks.ts) and its unit table (doc-edit.test.ts) run
// the same code; doc-edit-yjs.ts writes the result back into the ydoc.
//
// **Three steps.**
//
// 1. Each edit's passage is found in the doc as it is — §7's matcher, where
//    only an exact match applies, a near miss is reported, and a passage that
//    occurs twice is refused — and the edits are applied with one ProseMirror
//    Transform, last first, so every position stays valid. That gets the
//    *structure* right: a replacement that opens or closes blocks fits the
//    way typing it would.
// 2. The changed blocks are aligned with the blocks they replace — by text,
//    then by likeness between anchors (block-align.ts) — and each pair is
//    merged **word by word** (`diffText`): a word whose text survived keeps
//    every mark it had (an annotation's highlight, a person's author colour,
//    a link) and gains or loses only the formatting the new text gives it;
//    a word that is new carries the actor's `authorHighlight` and the
//    `annotation` marks of the text it replaces, or, inserted between two
//    words, only those on both sides of it.
// 3. The write-back (doc-edit-yjs.ts) goes block by block, never as a whole
//    fragment.
//
// The one difference from typing is at an edge: ProseMirror extends an
// inclusive mark over text typed at its end, and a sentence added after an
// annotated passage is no part of what the note was about, so it doesn't.

/** Marks Markdown can say — what a new text sets on a surviving word. Every other mark (authorHighlight, annotation) stays as it was. */
const FORMATTING_MARKS = new Set(["bold", "italic", "strike", "code", "link"]);

/** A passage to change, named by its words (`quote`) or by its ends (`start`, `end`), as §7 names one. */
export type EditTarget = QuoteSpec & {
  /** Let a passage named by its ends run across a heading, which is refused otherwise. */
  acrossHeadings?: boolean;
  /**
   * The passage's text at the version the client read it at, when the log has
   * moved past that version: a passage named by its ends isn't sent, so its
   * middle is checked against this, and one a person has typed in since is
   * refused with its text now rather than overwritten unseen.
   */
  expectText?: string;
};

/** One edit, as the edit endpoint takes it: blocks are TipTap JSON, already parsed from Markdown and validated. */
export type EditSpec =
  | { kind: "replace"; target: EditTarget; blocks: JSONContent[] }
  | { kind: "append"; blocks: JSONContent[] }
  | { kind: "insert"; heading: string | number; atEnd?: boolean; blocks: JSONContent[] }
  // Reverting an edit (§6) works by whole top-level blocks found by their
  // exact text, with the restored block's own marks kept.
  | { kind: "replaceBlock"; text: string; block: JSONContent }
  | { kind: "deleteBlock"; text: string }
  | { kind: "insertBlock"; afterText: string | null; block: JSONContent };

export type EditRefusal = {
  code: "no_match" | "ambiguous" | "invalid" | "conflict";
  message: string;
  details?: Record<string, unknown>;
  /** Which edit, 0-based. */
  edit: number;
};

export type EditPlan =
  | {
      ok: true;
      next: PMNode;
      /** Each edit's passage in the doc as it was, for working out which annotations and links it touched. */
      ranges: { from: number; to: number }[];
      /** Block numbers, in the doc after the edit, of every block the edit changed or added. */
      changed: number[];
    }
  | { ok: false; refusal: EditRefusal };

export type MergeOptions = {
  schema: Schema;
  /** Who the new words are by: their `authorHighlight`. Null writes no author mark. */
  authorId: string | null;
  /** Revert: new words keep the marks they arrive with, and gain neither the actor's mark nor any inherited one. */
  keepMarks?: boolean;
};

type Atom = { text: string; marks: readonly Mark[]; leaf: PMNode | null };

/** A textblock as one atom per UTF-16 code unit of its text form, a hard break as "\n". */
function atomsOf(textblock: PMNode): Atom[] {
  const atoms: Atom[] = [];
  textblock.forEach((child) => {
    if (child.isText) {
      for (const unit of (child.text ?? "").split("")) atoms.push({ text: unit, marks: child.marks, leaf: null });
    } else if (child.isInline && child.isLeaf) {
      atoms.push({ text: "\n", marks: child.marks, leaf: child });
    }
  });
  return atoms;
}

function annotationsOf(marks: readonly Mark[] | undefined): Mark[] {
  return (marks ?? []).filter((mark) => mark.type.name === "annotation");
}

/** The annotation marks two neighbouring characters share: what a word inserted between them falls inside. */
function sharedAnnotations(before: Atom | undefined, after: Atom | undefined): Mark[] {
  if (!before || !after) return [];
  return annotationsOf(before.marks).filter((mark) => after.marks.some((other) => other.eq(mark)));
}

function toSet(marks: readonly Mark[]): readonly Mark[] {
  let set: readonly Mark[] = Mark.none;
  for (const mark of marks) set = mark.addToSet(set);
  return set;
}

/** A surviving character: every mark it had, with the formatting the new text gives it in place of its old formatting. */
function reconcile(old: Atom, next: Atom): Atom {
  const kept = old.marks.filter((mark) => !FORMATTING_MARKS.has(mark.type.name));
  const formatting = next.marks
    .filter((mark) => FORMATTING_MARKS.has(mark.type.name))
    // A link to the same place keeps the attributes it had (rel, target).
    .map((mark) =>
      mark.type.name === "link"
        ? (old.marks.find((o) => o.type.name === "link" && o.attrs.href === mark.attrs.href) ?? mark)
        : mark,
    );
  return { text: old.text, marks: toSet([...kept, ...formatting]), leaf: old.leaf };
}

function authorMark(options: MergeOptions): Mark | null {
  return options.authorId ? options.schema.marks.authorHighlight.create({ authorId: options.authorId }) : null;
}

/** A new character: the new text's formatting, the inherited annotations, and the actor's author mark. */
function fresh(next: Atom, inherited: readonly Mark[], options: MergeOptions): Atom {
  if (options.keepMarks) return next;
  const author = authorMark(options);
  const marks = [
    ...next.marks.filter((mark) => FORMATTING_MARKS.has(mark.type.name)),
    ...inherited,
    ...(author ? [author] : []),
  ];
  return { text: next.text, marks: toSet(marks), leaf: next.leaf };
}

/** Atoms back into a textblock of `type`: runs of one mark set as one text node, marks the type disallows dropped. */
function build(template: PMNode, atoms: readonly Atom[]): PMNode {
  const type = template.type;
  const allowed = (marks: readonly Mark[]) => marks.filter((mark) => type.allowsMarkType(mark.type));
  const nodes: PMNode[] = [];
  let text = "";
  let marks: readonly Mark[] = Mark.none;
  const flush = () => {
    if (text) nodes.push(type.schema.text(text, marks));
    text = "";
  };
  for (const atom of atoms) {
    if (atom.leaf) {
      flush();
      nodes.push(atom.leaf.mark(allowed(atom.marks)));
      continue;
    }
    const atomMarks = allowed(atom.marks);
    if (!Mark.sameSet(atomMarks, marks)) {
      flush();
      marks = atomMarks;
    }
    text += atom.text;
  }
  flush();
  return type.create(template.attrs, nodes, template.marks);
}

/**
 * Two versions of one textblock merged word by word: what survived keeps its
 * marks, what is new is marked as new (above). The result takes the new
 * block's type and attributes, so a paragraph that became a heading is one.
 */
export function mergeTextblock(old: PMNode, next: PMNode, options: MergeOptions): PMNode {
  const oa = atomsOf(old);
  const na = atomsOf(next);
  const tokens = diffText(
    oa.map((a) => a.text).join(""),
    na.map((a) => a.text).join(""),
    tokenizeFine,
  );
  const out: Atom[] = [];
  let oi = 0;
  let ni = 0;
  let k = 0;
  while (k < tokens.length) {
    const token = tokens[k];
    if (token.type === "equal") {
      for (let c = 0; c < token.value.length; c++) out.push(reconcile(oa[oi + c], na[ni + c]));
      oi += token.value.length;
      ni += token.value.length;
      k++;
      continue;
    }
    // A hunk: every change between two equal tokens. Its new words take the
    // annotations of the first word they replace — what typing over a
    // selection does (ProseMirror's marksAcross) — or, replacing nothing,
    // only those on both sides of where they go.
    let end = k;
    while (end < tokens.length && tokens[end].type !== "equal") end++;
    const deletedFrom = oi;
    const inserted: Atom[] = [];
    for (const change of tokens.slice(k, end)) {
      if (change.type === "delete") {
        oi += change.value.length;
      } else {
        inserted.push(...na.slice(ni, ni + change.value.length));
        ni += change.value.length;
      }
    }
    const inherited =
      oi > deletedFrom ? annotationsOf(oa[deletedFrom].marks) : sharedAnnotations(oa[deletedFrom - 1], oa[deletedFrom]);
    for (const atom of inserted) out.push(fresh(atom, inherited, options));
    k = end;
  }
  return build(next, out);
}

/** A block that has no counterpart: all of it is new, and by the actor. */
export function markNew(node: PMNode, options: MergeOptions): PMNode {
  if (options.keepMarks) return node;
  const author = authorMark(options);
  if (!author) return node;
  if (node.isTextblock) {
    const children: PMNode[] = [];
    node.forEach((child) => {
      children.push(child.isText && node.type.allowsMarkType(author.type) ? child.mark(author.addToSet(child.marks)) : child);
    });
    return node.type.create(node.attrs, children, node.marks);
  }
  if (node.isLeaf) return node;
  const children: PMNode[] = [];
  node.forEach((child) => children.push(markNew(child, options)));
  return node.type.create(node.attrs, children, node.marks);
}

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

/** A block's identity for alignment: all of it, marks included, so a block whose marks changed isn't an anchor. */
export function blockKey(node: PMNode): string {
  return JSON.stringify(node.toJSON());
}

/**
 * Two versions of one block merged: textblocks word by word, a container
 * child by child (aligned as the doc's own blocks are), and anything else —
 * a block that changed kind — taken as new.
 */
export function mergeBlock(old: PMNode, next: PMNode, options: MergeOptions): PMNode {
  if (old.eq(next)) return old;
  if (old.isTextblock && next.isTextblock) return mergeTextblock(old, next, options);
  if (old.type === next.type && !old.isLeaf && !old.isTextblock) {
    const oc = childrenOf(old);
    const nc = childrenOf(next);
    const pairs = alignBlocks(
      oc.map(blockText),
      nc.map(blockText),
      { old: oc.map(blockKey), new: nc.map(blockKey) },
    );
    const children = pairs.flatMap((pair) =>
      pair.new === null
        ? []
        : pair.old === null
          ? [markNew(nc[pair.new], options)]
          : [mergeBlock(oc[pair.old], nc[pair.new], options)],
    );
    return next.type.create(next.attrs, children, next.marks);
  }
  return markNew(next, options);
}

/**
 * One whole document merged into another, top-level block by block — what
 * planEdits does after its Transform, for a caller that has the new document
 * whole: the MCP server's edit_annotation, whose body is short enough to send
 * entire and whose surviving words must still keep their marks.
 */
export function mergeDoc(old: PMNode, next: PMNode, options: MergeOptions): PMNode {
  const oc = childrenOf(old);
  const nc = childrenOf(next);
  const pairs = alignBlocks(oc.map(blockText), nc.map(blockText), { old: oc.map(blockKey), new: nc.map(blockKey) });
  const merged = pairs.flatMap((pair) =>
    pair.new === null ? [] : pair.old === null ? [markNew(nc[pair.new], options)] : [mergeBlock(oc[pair.old], nc[pair.new], options)],
  );
  return old.type.create(old.attrs, merged, old.marks);
}

/** Text in pasted Markdown keeps a soft line break as "\n"; in an edit it is the space CommonMark means by one. */
function collapseSoftBreaks(json: JSONContent): JSONContent {
  return {
    ...json,
    ...(typeof json.text === "string" ? { text: json.text.replace(/\r?\n/g, " ") } : {}),
    ...(json.content ? { content: json.content.map(collapseSoftBreaks) } : {}),
  };
}

type Op = { edit: number; from: number; to: number; slice: Slice };

function refuse(edit: number, code: EditRefusal["code"], message: string, details?: Record<string, unknown>): EditPlan {
  return { ok: false, refusal: { edit, code, message, ...(details ? { details } : {}) } };
}

/** Where a range is, for a refusal: its blocks and the context around it. */
function where(target: FlatTarget, blocks: readonly DocBlock[], range: { from: number; to: number }) {
  const at = blocksOfRange(blocks, range.from, range.to);
  return {
    context: contextOf(target, range),
    ...(at ? { blocks: at.from === at.to ? String(at.from) : `${at.from}-${at.to}` } : {}),
  };
}

/** The one top-level block whose text is exactly `text`, or a refusal-shaped null. */
function blockByText(blocks: readonly DocBlock[], text: string): DocBlock | null {
  const found = blocks.filter((block) => block.text === text);
  return found.length === 1 ? found[0] : null;
}

/**
 * Plans `edits` against `doc`: every passage found, every refusal raised,
 * before anything is applied — the request is all-or-nothing. On success,
 * `next` is the doc after the edits, with marks merged as above.
 */
export function planEdits(
  doc: PMNode,
  edits: readonly EditSpec[],
  options: MergeOptions & { asText: (markdown: string) => string },
): EditPlan {
  const schema = options.schema;
  const blocks = docBlocks(doc);
  const target = flattenForMatch(doc);
  const ops: Op[] = [];
  const ranges: { from: number; to: number }[] = [];
  const fragmentOf = (json: readonly JSONContent[]) =>
    Fragment.fromArray(json.map((block) => schema.nodeFromJSON(options.keepMarks ? block : collapseSoftBreaks(block))));

  for (const [index, edit] of edits.entries()) {
    let fragment: Fragment;
    try {
      fragment =
        edit.kind === "deleteBlock"
          ? Fragment.empty
          : edit.kind === "replaceBlock" || edit.kind === "insertBlock"
            ? fragmentOf([edit.block])
            : fragmentOf(edit.blocks);
    } catch (err) {
      return refuse(index, "invalid", `The new content isn't valid for a doc: ${err instanceof Error ? err.message : String(err)}`);
    }

    switch (edit.kind) {
      case "replace": {
        const resolution = resolveQuote(target, edit.target, options.asText);
        if (resolution.kind === "none") {
          return refuse(index, "no_match", "That passage isn't in the doc as written.", {
            nearMisses: resolution.nearMisses.map((miss) => ({ text: miss.quotedText, ...where(target, blocks, miss) })),
          });
        }
        if (resolution.matches.length > 1) {
          return refuse(index, "ambiguous", "That passage occurs more than once; add a prefix or suffix.", {
            occurrences: resolution.matches.slice(0, 5).map((match) => where(target, blocks, match)),
            total: resolution.matches.length,
          });
        }
        const match = resolution.matches[0];
        const named = !edit.target.quote?.trim();
        if (named && !edit.target.acrossHeadings) {
          const at = blocksOfRange(blocks, match.from, match.to);
          if (at && blocks.slice(at.from, at.to).some((block) => block.heading)) {
            return refuse(index, "invalid", "That passage runs across a heading; pass acrossHeadings if it should.", {
              ...where(target, blocks, match),
            });
          }
        }
        if (edit.target.expectText !== undefined) {
          const now = quotedTextAt(doc, match.from, match.to);
          if (normalizeForMatch(now).text !== normalizeForMatch(edit.target.expectText).text) {
            return refuse(index, "conflict", "That passage has changed since you read it.", { textNow: now });
          }
        }
        ranges.push({ from: match.from, to: match.to });

        // One paragraph of new text goes inline, into the textblock the
        // passage is in, which keeps that block's kind (a heading stays one).
        // Anything else is blocks: open on a side where the passage starts or
        // ends inside a block, so the text before and after it joins the
        // first and last new block, and closed where it covers a block whole,
        // so a paragraph can become a heading.
        // Nothing new: the passage is deleted, and blocks it ran across join.
        if (fragment.childCount === 0) {
          ops.push({ edit: index, from: match.from, to: match.to, slice: Slice.empty });
          break;
        }
        const $from = doc.resolve(match.from);
        const $to = doc.resolve(match.to);
        const single = fragment.childCount === 1 && fragment.firstChild!.type.name === "paragraph";
        if (single && $from.sameParent($to) && $from.parent.isTextblock) {
          ops.push({ edit: index, from: match.from, to: match.to, slice: new Slice(fragment.firstChild!.content, 0, 0) });
          break;
        }
        let from = match.from;
        let to = match.to;
        let openStart = 1;
        let openEnd = 1;
        if ($from.parent.isTextblock && $from.parentOffset === 0) {
          from = $from.before();
          openStart = 0;
        }
        if ($to.parent.isTextblock && $to.parentOffset === $to.parent.content.size) {
          to = $to.after();
          openEnd = 0;
        }
        if (single && openStart === 0 && openEnd === 0) {
          // A whole textblock replaced by one paragraph keeps its kind, as inline.
          ops.push({ edit: index, from: match.from, to: match.to, slice: new Slice(fragment.firstChild!.content, 0, 0) });
          break;
        }
        ops.push({ edit: index, from, to, slice: new Slice(fragment, openStart, openEnd) });
        break;
      }
      case "append":
        ops.push({ edit: index, from: doc.content.size, to: doc.content.size, slice: new Slice(fragment, 0, 0) });
        break;
      case "insert": {
        const found = findHeading(blocks, edit.heading);
        if (found.kind === "ambiguous") {
          return refuse(index, "ambiguous", `More than one heading reads "${edit.heading}"; name it by block number.`, {
            blocks: found.blocks,
            total: found.total,
          });
        }
        if (found.kind !== "found") return refuse(index, "no_match", `No heading ${JSON.stringify(edit.heading)} in this doc.`);
        const at = edit.atEnd ? blocks[sectionOf(blocks, found.block.number).to - 1].to : found.block.to;
        ops.push({ edit: index, from: at, to: at, slice: new Slice(fragment, 0, 0) });
        break;
      }
      case "replaceBlock":
      case "deleteBlock": {
        const block = blockByText(blocks, edit.text);
        if (!block) return refuse(index, "conflict", "That block has changed since; it was left as it is.");
        ops.push({ edit: index, from: block.from, to: block.to, slice: new Slice(fragment, 0, 0) });
        ranges.push({ from: block.from, to: block.to });
        break;
      }
      case "insertBlock": {
        const after = edit.afterText === null ? null : blockByText(blocks, edit.afterText);
        if (edit.afterText !== null && !after) {
          return refuse(index, "conflict", "The block it followed has changed since; it was left out.");
        }
        const at = after ? after.to : 0;
        ops.push({ edit: index, from: at, to: at, slice: new Slice(fragment, 0, 0) });
        break;
      }
    }
  }

  // All-or-nothing, and no two edits may touch the same text.
  const sorted = [...ops].sort((a, b) => a.from - b.from || a.edit - b.edit);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from < sorted[i - 1].to) {
      return refuse(sorted[i].edit, "invalid", `Edits ${sorted[i - 1].edit + 1} and ${sorted[i].edit + 1} overlap; combine them.`);
    }
  }

  // Applied last first, so the earlier positions stay valid; at one position,
  // the earlier edit ends up first.
  const tr = new Transform(doc);
  for (const op of [...ops].sort((a, b) => b.from - a.from || b.edit - a.edit)) {
    try {
      tr.replace(op.from, op.to, op.slice);
    } catch (err) {
      return refuse(op.edit, "invalid", `That edit doesn't fit the doc's structure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const shaped = tr.doc;

  // Step 2: the merge, top-level block by block.
  const oc = childrenOf(doc);
  const nc = childrenOf(shaped);
  const pairs = alignBlocks(oc.map(blockText), nc.map(blockText), { old: oc.map(blockKey), new: nc.map(blockKey) });
  const merged: PMNode[] = [];
  const changed: number[] = [];
  for (const pair of pairs) {
    if (pair.new === null) continue;
    const block =
      pair.old === null ? markNew(nc[pair.new], options) : mergeBlock(oc[pair.old], nc[pair.new], options);
    merged.push(block);
    if (pair.old === null || !block.eq(oc[pair.old])) changed.push(merged.length);
  }
  let next: PMNode;
  try {
    next = doc.type.create(doc.attrs, merged, doc.marks);
    next.check();
  } catch (err) {
    return refuse(0, "invalid", `The edited doc isn't valid: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, next, ranges, changed };
}

/**
 * A title rewritten as a targeted edit is (§6, "The title is a Yjs
 * fragment"): the old title's paragraph merged with the new one word by
 * word, so the words that survive keep whoever typed them. `schema` is the
 * title schema with the author mark (titleAuthorHighlightExtensions).
 */
export function planTitle(oldTitle: PMNode | null, text: string, options: MergeOptions): PMNode {
  const schema = options.schema;
  const paragraph = schema.node("paragraph", null, text ? [schema.text(text.replace(/\s+/g, " ").trim())] : []);
  const old = oldTitle?.firstChild ?? null;
  const merged = old ? mergeTextblock(old, paragraph, options) : markNew(paragraph, options);
  return schema.node("doc", null, [merged]);
}
