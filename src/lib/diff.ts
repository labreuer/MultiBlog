type PMNode = {
  type: string;
  content?: PMNode[];
  text?: string;
};

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "horizontalRule",
]);

function walk(node: PMNode, parts: string[]): void {
  if (node.type === "text" && node.text) {
    parts.push(node.text);
  }
  if (node.content) {
    for (const child of node.content) {
      walk(child, parts);
    }
  }
  if (BLOCK_TYPES.has(node.type)) {
    parts.push("\n\n");
  }
}

// Flattens a ProseMirror JSON doc to plain text for diffing/display purposes.
// Not meant to round-trip — block boundaries just become blank lines.
export function extractText(doc: unknown): string {
  const parts: string[] = [];
  walk(doc as PMNode, parts);
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

// Word-level LCS diff. O(n*m) — fine at the doc sizes a hobby blog produces.
export function diffText(oldText: string, newText: string): DiffToken[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
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
