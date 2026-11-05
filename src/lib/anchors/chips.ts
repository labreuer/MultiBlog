import type { Node as PMNode } from "@tiptap/pm/model";
import { chipAttrsOf, chipIdentity, UNKNOWN_CHIP } from "../entity-chips/renderings";
import type { ChipLabels } from "../entity-chips/text";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP } from "../entity-chips/types";

// docs/ENTITY_CHIPS.md, step 1, item 11 — the chip record: which entity
// chips a doc-range anchor's passage holds.
//
// A stored quote holds U+FFFC where a chip is (rule 3), which is what keeps
// an anchor attached through a rename, and also what makes the quote say
// nothing about *which* chip. The record says it, for three readers:
//
//  - **A surface showing the quote with no ydoc open** (`/annotations`,
//    `/links`, the link tray, a card's quote line, MCP's thread reads, the
//    annotation search vector) puts each chip's label where its U+FFFC is.
//  - **The resolvers** check identity, so a passage whose chip now stands for
//    someone else no longer matches, though its text does.
//  - **Instance anchoring:** U+FFFC can't tell two chips apart, and an
//    `annotation` mark can't sit on a chip at all (y-tiptap stores no marks
//    on an inline node). The instance id finds the one chip an anchor means.
//
// A record carries the chip's fields rather than only its identity: a label
// is computed from the fields, and the identity is derived from them by the
// chip kind. Its `label` is the label as of the write, as `prose_json`'s is
// (item 8): the refresh rewrites it when its target is renamed (item 10).
//
// Where it lives: in the DOC_RANGE selector of a tag, link or comment-quote
// anchor, and in `annotation.anchor_chips` beside an annotation's anchor
// columns.
//
// Browser-safe.

export type ChipRecord = {
  /** Where the chip's U+FFFC is in the anchor's `quotedText`, in UTF-16 units. */
  at: number;
  /** The chip kind. */
  kind: string;
  /** The chip's instance id. */
  iid: string;
  /** The chip kind's fields, as the node held them. */
  data: Record<string, unknown>;
  /** The chip's label as of the write, or the last refresh. Absent when the writer had none to give. */
  label?: string;
};

/** No anchor holds more chips than this; a longer list is a malformed blob. */
const MAX_RECORDS = 2000;

/**
 * The records for the chips inside `[from, to)`, in order. `at` indexes
 * `node.textBetween(from, to, " ")`, the text an anchor stores for that range.
 */
export function chipRecordsBetween(node: PMNode, from: number, to: number, labels?: ChipLabels): ChipRecord[] {
  const records: ChipRecord[] = [];
  node.nodesBetween(from, to, (child, pos) => {
    if (child.type.name === ENTITY_CHIP && pos >= from && pos < to) {
      const { kind, iid, data } = chipAttrsOf(child.attrs);
      const label = labels?.get(iid);
      // The text before the chip is a prefix of the whole range's: a block
      // separator is written when its block is entered, which is before
      // anything in it.
      const at = node.textBetween(from, pos, " ").length;
      records.push({ at, kind, iid, data, ...(label !== undefined ? { label } : {}) });
    }
    return !child.isLeaf;
  });
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored record list, read back. Empty for anything that isn't one: a
 * column is untrusted input whoever wrote it, and an anchor with no record
 * is one every reader already handles.
 */
export function parseChipRecords(value: unknown): ChipRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return [];
  const records: ChipRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return [];
    const { at, kind, iid, data, label } = entry;
    if (!Number.isInteger(at) || (at as number) < 0) return [];
    if (typeof kind !== "string" || typeof iid !== "string" || !isRecord(data)) return [];
    if (label !== undefined && typeof label !== "string") return [];
    records.push({ at: at as number, kind, iid, data, ...(typeof label === "string" ? { label } : {}) });
  }
  return records;
}

/**
 * A stored quote as a reader sees it: each chip's label where its U+FFFC is.
 * `labels`, when a surface has current ones, win over the stored label. A
 * record that doesn't point at a U+FFFC describes some other text and is
 * skipped, so a quote and a list that disagree show the quote as it is.
 */
export function quoteWithChipLabels(
  quotedText: string,
  chips: readonly ChipRecord[] | null | undefined,
  labels?: ChipLabels,
): string {
  if (!chips || chips.length === 0) return quotedText;
  let out = "";
  let done = 0;
  for (const chip of [...chips].sort((a, b) => a.at - b.at)) {
    if (chip.at < done || quotedText[chip.at] !== CHIP_ANCHOR_TEXT) continue;
    out += quotedText.slice(done, chip.at) + (labels?.get(chip.iid) ?? chip.label ?? UNKNOWN_CHIP.label);
    done = chip.at + 1;
  }
  return out + quotedText.slice(done);
}

/** What each recorded chip stands for, in order: the list a range's own chips are compared with. */
export function recordIdentities(chips: readonly ChipRecord[]): string[] {
  return [...chips].sort((a, b) => a.at - b.at).map(chipIdentity);
}

/** The records with each label recomputed from `labels`, by instance id; a chip `labels` doesn't hold keeps what it had. */
export function relabelChipRecords(chips: readonly ChipRecord[], labels: ChipLabels): ChipRecord[] {
  return chips.map((chip) => {
    const label = labels.get(chip.iid);
    return label === undefined ? chip : { ...chip, label };
  });
}

/**
 * How a range's own chips compare with an anchor's records, in order:
 * `"instance"` when each is the recorded chip itself, `"identity"` when each
 * stands for the recorded entity but at least one is another instance, null
 * when the range holds a different entity somewhere, or a different number of
 * chips. The text can't answer this: every chip reads U+FFFC.
 */
export function chipMatch(node: PMNode, from: number, to: number, chips: readonly ChipRecord[]): "instance" | "identity" | null {
  const want = [...chips].sort((a, b) => a.at - b.at);
  let index = 0;
  let same = true;
  let instance = true;
  node.nodesBetween(from, to, (child, pos) => {
    if (same && child.type.name === ENTITY_CHIP && pos >= from && pos < to) {
      const have = chipAttrsOf(child.attrs);
      const wanted = want[index++];
      if (!wanted || chipIdentity(wanted) !== chipIdentity(have)) same = false;
      else if (wanted.iid !== have.iid) instance = false;
    }
    return same && !child.isLeaf;
  });
  if (!same || index !== want.length) return null;
  return instance ? "instance" : "identity";
}

/** Whether a quote is chips and nothing else: such an anchor means those chips, not their neighbourhood. */
export function isChipOnlyQuote(quotedText: string): boolean {
  return quotedText.includes(CHIP_ANCHOR_TEXT) && quotedText.replaceAll(CHIP_ANCHOR_TEXT, "").trim() === "";
}

// --- A mark-anchored passage's edge chips ----------------------------------
//
// The doc editor anchors an annotation with a mark in the doc's own text
// (docs/ANNOTATIONS.md, "Anchoring"), and a mark can't sit on a chip. A chip
// between two marked runs is inside the mark's hull anyway. One before the
// passage's first character or after its last is not, and a passage that is
// a chip alone has no mark at all. Those chips are recorded on the row, and
// found again by instance id.

/** Of a range's chips, the ones outside its text: before its first character, or after its last. */
export function edgeChipRecords(node: PMNode, from: number, to: number, labels?: ChipLabels): ChipRecord[] {
  const records = chipRecordsBetween(node, from, to, labels);
  const length = node.textBetween(from, to, " ").length;
  return records.filter((record, index) => record.at === index || record.at === length - (records.length - index));
}

/** Whether an edge record sat before its passage's text. `index` is its place among the row's records, in order. */
function isLeadingEdge(record: ChipRecord, index: number): boolean {
  return record.at === index;
}

/**
 * A mark-anchored passage as a reader sees it: the marked text, with the
 * labels of its edge chips before and after. `labels` are the doc's current
 * ones by instance id; an edge chip the doc no longer holds is left out, so
 * a passage whose only chip is gone reads as no passage.
 */
export function quoteWithEdgeChips(markedText: string, chips: readonly ChipRecord[], labels: ChipLabels): string {
  if (chips.length === 0) return markedText;
  const sorted = [...chips].sort((a, b) => a.at - b.at);
  let before = "";
  let after = "";
  sorted.forEach((record, index) => {
    const label = labels.get(record.iid);
    if (label === undefined) return;
    if (isLeadingEdge(record, index)) before += label;
    else after += label;
  });
  return before + markedText + after;
}

/**
 * Where a mark-anchored passage is, given its mark's hull (null for none)
 * and its edge records: the hull stretched over each edge chip still in its
 * place, or the chips' own span for a passage with no marked text. `chipAt`
 * finds a chip by instance id, and answers nothing for an id two chips share.
 *
 * An edge chip counts only in the textblock the hull's nearer end is in. A
 * chip cut and pasted far away keeps its id, and stretching the passage to
 * wherever it went would mark a page of text nobody chose.
 */
export function rangeWithEdgeChips(
  node: PMNode,
  hull: { from: number; to: number } | null,
  chips: readonly ChipRecord[],
  chipAt: (iid: string) => number | undefined,
): { from: number; to: number } | null {
  const sorted = [...chips].sort((a, b) => a.at - b.at);
  const blockStart = (pos: number) => node.resolve(pos).start();
  let range = hull ? { ...hull } : null;
  // Leading chips nearest the passage first, so each joins a range that already reaches it.
  const leading = sorted.filter(isLeadingEdge).reverse();
  const trailing = sorted.filter((record, index) => !isLeadingEdge(record, index));
  for (const record of [...leading, ...trailing]) {
    const pos = chipAt(record.iid);
    if (pos === undefined) continue;
    if (!range) {
      range = { from: pos, to: pos + 1 };
    } else if (pos < range.from) {
      if (blockStart(pos) === blockStart(range.from)) range.from = pos;
    } else if (pos >= range.to) {
      if (blockStart(pos) === blockStart(range.to)) range.to = pos + 1;
    }
  }
  return range;
}

/** Every chip's position by instance id; an id two chips share maps to nothing, so nothing resolves by it. */
export function chipPositions(node: PMNode): (iid: string) => number | undefined {
  const positions = new Map<string, number | null>();
  node.descendants((child, pos) => {
    if (child.type.name === ENTITY_CHIP) {
      const iid = chipAttrsOf(child.attrs).iid;
      positions.set(iid, positions.has(iid) ? null : pos);
    }
    return !child.isLeaf;
  });
  return (iid) => positions.get(iid) ?? undefined;
}
