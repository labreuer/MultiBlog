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
