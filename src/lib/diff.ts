import { chipDisplayText, isChip, type ChipLabels } from "./entity-chips/text";

type PMNode = {
  type: string;
  content?: PMNode[];
  text?: string;
  attrs?: Record<string, unknown>;
};

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "horizontalRule",
]);

function walk(node: PMNode, parts: string[], labels: ChipLabels | undefined): void {
  if (node.type === "text" && node.text) {
    parts.push(node.text);
  } else if (isChip(node)) {
    parts.push(chipDisplayText(node.attrs, labels));
  }
  if (node.content) {
    for (const child of node.content) {
      walk(child, parts, labels);
    }
  }
  if (BLOCK_TYPES.has(node.type)) {
    parts.push("\n\n");
  }
}

// Flattens a ProseMirror JSON doc to plain text for diffing/display purposes.
// Not meant to round-trip — block boundaries just become blank lines.
//
// An entity chip gives its display text (entity-chips/text.ts): its label
// from `labels`, for a body that holds none, such as an annotation's, or the
// one materialized on the node.
export function extractText(doc: unknown, labels?: ChipLabels): string {
  const parts: string[] = [];
  walk(doc as PMNode, parts, labels);
  return parts.join("").trim();
}

// Order-independent structural equality for two ProseMirror JSON docs.
// Postgres jsonb does not preserve object key order on read-back, so a doc
// round-tripped through the DB can have different key order than the one
// just produced by editor.getJSON() even when semantically identical — a
// plain JSON.stringify comparison would false-positive as "changed" on key
// order alone. Used to skip creating a no-op revision.
export function docsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => docsEqual(item, b[i]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) &&
    docsEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export type DiffToken = { value: string; type: "equal" | "insert" | "delete" };

function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [];
}

/**
 * Words, runs of whitespace, and each punctuation mark on its own — for a
 * diff whose tokens carry marks (src/lib/doc-edit.ts), where a comma typed
 * after an annotated word must not count as rewriting the word.
 */
export function tokenizeFine(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu) ?? [];
}

/**
 * What a size cap does when it bites (docs/MCP.md §6, "Size guards"): a read
 * shows less detail past it, and an edit is refused, since merging with less
 * detail would lose marks.
 */
export type CapMode = "read" | "edit";

/** An edit past a size cap: too large to merge word by word, so refused rather than merged with less detail. */
export class TooLargeToMerge extends Error {
  constructor() {
    super("That edit is too large to merge word by word; make it in smaller pieces.");
    this.name = "TooLargeToMerge";
  }
}

/** The word diff's cap, in table cells (old tokens × new): about 2,000 tokens a side, and 32 MB as the table is held. */
export const WORD_DIFF_MAX_CELLS = 4_000_000;

/** The longest common subsequence of two token lists, as a diff. O(n·m) in time and space. */
function lcsDiff(a: readonly string[], b: readonly string[]): DiffToken[] {
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ value: a[i], type: "equal" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ value: a[i], type: "delete" });
      i++;
    } else {
      result.push({ value: b[j], type: "insert" });
      j++;
    }
  }
  while (i < n) {
    result.push({ value: a[i], type: "delete" });
    i++;
  }
  while (j < m) {
    result.push({ value: b[j], type: "insert" });
    j++;
  }
  return result;
}

/**
 * Word-level LCS diff. Its table is every old token by every new one, so a
 * pair past `WORD_DIFF_MAX_CELLS` first has its shared start and end trimmed,
 * which can change at most which of several equal tokens counts as the
 * unchanged one, and is diffed if that brings it under. If not, a read gets
 * the changed middle removed and added whole, and an edit throws
 * `TooLargeToMerge`.
 */
export function diffText(
  oldText: string,
  newText: string,
  split: (text: string) => string[] = tokenize,
  mode: CapMode = "read",
): DiffToken[] {
  const a = split(oldText);
  const b = split(newText);
  if (a.length * b.length <= WORD_DIFF_MAX_CELLS) return lcsDiff(a, b);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldMiddle = a.slice(head, a.length - tail);
  const newMiddle = b.slice(head, b.length - tail);
  let middle: DiffToken[];
  if (oldMiddle.length * newMiddle.length <= WORD_DIFF_MAX_CELLS) {
    middle = lcsDiff(oldMiddle, newMiddle);
  } else if (mode === "edit") {
    throw new TooLargeToMerge();
  } else {
    middle = [
      { value: oldMiddle.join(""), type: "delete" },
      { value: newMiddle.join(""), type: "insert" },
    ];
  }
  const equal = (value: string): DiffToken => ({ value, type: "equal" });
  return [...a.slice(0, head).map(equal), ...middle, ...a.slice(a.length - tail).map(equal)];
}
