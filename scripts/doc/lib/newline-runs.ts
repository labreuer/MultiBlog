// The "how many newlines in a row" model shared by scripts/doc/count-newline-runs.ts
// (which reports them) and scripts/doc/collapse-blank-lines.ts (which removes some
// of them). One definition, because the second script decides what to delete
// from the first's answer — if the two walked the tree differently it would
// delete the wrong blocks and the report would never converge.
//
// A doc's body is TipTap JSON (Doc.proseJson), a tree of block nodes, with no
// literal "\n" anywhere in it. So "newlines" here means the newlines of the
// doc's plain-text rendering:
//   - each leaf block (paragraph, heading, codeBlock, a listItem's paragraph)
//     renders as one line;
//   - an empty paragraph renders as an empty line, so one empty paragraph
//     between two filled ones is a run of 2, two empties is a run of 3, ...;
//   - a hardBreak inside a block starts a new line, so a block can render as
//     more than one — which is why a Line carries `whole`.
// Container blocks contribute no line of their own; their children's lines are
// joined like any others.

export const CONTAINERS = new Set([
  "doc",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
]);

export type Node = {
  type?: string;
  content?: Node[];
  text?: string;
};

export type Line = {
  text: string;
  /**
   * Index of the leaf block this line came from, in the same depth-first order
   * a walk of the doc's Yjs XmlFragment produces. This is the handle
   * collapse-blank-lines.ts uses to find the node to delete.
   */
  blockIndex: number;
  /**
   * True when the leaf block rendered as exactly this one line — i.e. deleting
   * the block deletes exactly this line. False for the pieces a hardBreak
   * splits a block into, which can't be removed by deleting a whole block.
   */
  whole: boolean;
};

/** Lines of one leaf block: one, unless a hardBreak inside splits it. */
function leafBlockLines(node: Node): string[] {
  const lines: string[] = [""];
  const walkInline = (nodes: Node[]) => {
    for (const child of nodes) {
      if (child.type === "hardBreak") lines.push("");
      else if (child.type === "text") lines[lines.length - 1] += child.text ?? "";
      else walkInline(child.content ?? []);
    }
  };
  walkInline(node.content ?? []);
  return lines;
}

/** Every line of the document, in order, tagged with its leaf block. */
export function flattenLines(prose: unknown): Line[] {
  const lines: Line[] = [];
  let blockIndex = 0;

  const walk = (node: Node) => {
    if (CONTAINERS.has(node.type ?? "")) {
      for (const child of node.content ?? []) walk(child);
      return;
    }
    const own = leafBlockLines(node);
    for (const text of own) lines.push({ text, blockIndex, whole: own.length === 1 });
    blockIndex += 1;
  };

  if (prose && typeof prose === "object") walk(prose as Node);
  return lines;
}

export function linesToText(lines: Line[]): string {
  return lines.map((l) => l.text).join("\n");
}

export function renderText(prose: unknown): string {
  return linesToText(flattenLines(prose));
}

/**
 * Lengths of every maximal run of consecutive "\n". Runs that only trail the
 * end of the document are ignored, so a doc ending in blank paragraphs isn't
 * reported as one long run.
 */
export function newlineRuns(text: string): number[] {
  const trimmed = text.replace(/\n+$/, "");
  const runs: number[] = [];
  for (const match of trimmed.matchAll(/\n+/g)) runs.push(match[0].length);
  return runs;
}

export function runHistogram(runs: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const r of runs) counts.set(r, (counts.get(r) ?? 0) + 1);
  return counts;
}

export type BlankGroup = {
  /** Indices into `lines` of the consecutive empty lines. */
  lineIndices: number[];
  /** Newline-run length this group produces: one more than its size. */
  runLength: number;
};

/**
 * Maximal groups of consecutive empty lines that have a non-empty line on
 * *both* sides — the only ones that produce a newline run longer than 1.
 * Leading and trailing blanks are excluded on purpose: a blank first line
 * yields a run of 1 already, and trailing blanks yield no run at all, so
 * neither is a "2x" that could become a "1x".
 */
export function interiorBlankGroups(lines: Line[]): BlankGroup[] {
  const groups: BlankGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].text !== "") {
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].text === "") i += 1;
    const hasBefore = start > 0;
    const hasAfter = i < lines.length;
    if (hasBefore && hasAfter) {
      const lineIndices = [];
      for (let j = start; j < i; j++) lineIndices.push(j);
      groups.push({ lineIndices, runLength: lineIndices.length + 1 });
    }
  }
  return groups;
}
