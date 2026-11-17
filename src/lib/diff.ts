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

// The word diff itself is diff-text.ts's, which imports nothing, so that a
// browser worker can run it without the chip registry this file reaches
// (docs/FORKS.md, "Where the comparing is done").
export {
  diffText,
  tokenizeFine,
  TooLargeToMerge,
  WORD_DIFF_MAX_CELLS,
  type CapMode,
  type DiffCap,
  type DiffToken,
  type OnCap,
} from "./diff-text";
