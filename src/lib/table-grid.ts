// docs/TABLES.md, "CSV in and out of an existing doc" — the grid between a table file and a table node. Browser-safe
// (the editor's insert path runs it on the client) and ProseMirror-free in
// the reading direction: a codec (table-codecs.ts) turns a file into a
// TableGrid and back, and only this module knows what a `table` node looks
// like. docs/research/tables.md, "Adding xlsx to the interchange formats",
// is why the grid carries fields CSV never fills — colspan, rowspan and a
// link — and why the CSV *writer* flattens spans rather than
// `tableJsonToGrid` dropping them: a second codec (xlsx) keeps merged cells
// and hyperlinks, and must not inherit CSV's losses.

import type { JSONContent } from "@tiptap/core";

export type GridCell = {
  // Paragraphs separated by "\n". Marks other than a link are gone by the
  // time text is here — inherent to every interchange format on the list.
  text: string;
  colspan?: number;
  rowspan?: number;
  href?: string;
};

export type TableGrid = GridCell[][];

// The one guard that stands between a spreadsheet-sized file and the
// editor. Every cell is at least one paragraph node in a DOM ProseMirror
// renders in full, and PERFORMANCE.md records the debounced revision diff
// going super-linear well before a document reaches the size a 20,000-row
// CSV would make it. The editor's insert path has no request body and so
// no byte cap; an xlsx is a zip and a byte cap would say nothing anyway.
// So the limit is counted here, on the grid, after decode and before any
// node is built — for every codec alike. 2,000 is a starting number
// (a 200×10 table), to be moved once real tables have been measured.
export const MAX_TABLE_CELLS = 2000;

export class TableTooLargeError extends Error {
  constructor(
    public readonly rows: number,
    public readonly columns: number,
  ) {
    super(
      `${rows.toLocaleString("en-US")} rows × ${columns.toLocaleString("en-US")} columns is ${(rows * columns).toLocaleString("en-US")} cells — the limit is ${MAX_TABLE_CELLS.toLocaleString("en-US")}.`,
    );
    this.name = "TableTooLargeError";
  }
}

// Each row's effective width: its own cells' colspans plus the columns a
// rowspan from an earlier row still claims in it. Both the size and the
// padding below need it, and a rowspan is the case a naive count gets
// wrong — the row under a spanning cell holds one cell fewer and is not
// ragged for it.
function rowWidths(grid: TableGrid): number[] {
  // claimed[r] = how many columns rows above have reserved in row r, by
  // column index. A set of "r,c" keys, the same map gridToRectangle walks.
  const taken = new Set<string>();
  const widths: number[] = [];
  for (let r = 0; r < grid.length; r++) {
    let c = 0;
    for (const cell of grid[r]) {
      while (taken.has(`${r},${c}`)) c++;
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;
      for (let dr = 1; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) taken.add(`${r + dr},${c + dc}`);
      }
      c += colspan;
    }
    while (taken.has(`${r},${c}`)) c++;
    widths.push(c);
  }
  return widths;
}

/** Rows × widest row, spans counted by the cells they cover. */
export function gridSize(grid: TableGrid): { rows: number; columns: number } {
  return { rows: grid.length, columns: Math.max(0, ...rowWidths(grid)) };
}

export function assertGridWithinCap(grid: TableGrid): void {
  const { rows, columns } = gridSize(grid);
  if (rows * columns > MAX_TABLE_CELLS) throw new TableTooLargeError(rows, columns);
}

/** Every row brought to the widest row's width with empty cells. */
export function padGrid(grid: TableGrid): TableGrid {
  const widths = rowWidths(grid);
  const columns = Math.max(0, ...widths);
  return grid.map((row, r) =>
    widths[r] >= columns ? row : [...row, ...Array.from({ length: columns - widths[r] }, () => ({ text: "" }))],
  );
}

/** A rectangle of strings (a CSV, say) as a grid with no spans or links. */
export function rectangleToGrid(rows: string[][]): TableGrid {
  return rows.map((row) => row.map((text) => ({ text })));
}

/**
 * The grid flattened to a rectangle of strings: a spanned cell's value goes
 * in its first cell and the cells the span covers become empty strings, so
 * the shape stays rectangular and a spreadsheet reads it in place. Links go
 * as their text. What every span-less format's writer wants.
 */
export function gridToRectangle(grid: TableGrid): string[][] {
  // Occupancy by (row, column): the cells a rowspan from above has claimed.
  const taken = new Set<string>();
  const key = (r: number, c: number) => `${r},${c}`;
  const out: string[][] = [];
  for (let r = 0; r < grid.length; r++) {
    const line: string[] = [];
    let c = 0;
    for (const cell of grid[r]) {
      while (taken.has(key(r, c))) {
        line[c] = "";
        c++;
      }
      const colspan = cell.colspan ?? 1;
      const rowspan = cell.rowspan ?? 1;
      line[c] = cell.text;
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (dr === 0 && dc === 0) continue;
          taken.add(key(r + dr, c + dc));
          if (dr === 0) line[c + dc] = "";
        }
      }
      c += colspan;
    }
    // Trailing cells claimed by a rowspan from above, after the row's own.
    while (taken.has(key(r, c))) {
      line[c] = "";
      c++;
    }
    out.push(line);
  }
  const width = out.reduce((w, line) => Math.max(w, line.length), 0);
  return out.map((line) => Array.from({ length: width }, (_, i) => line[i] ?? ""));
}

// --- grid → table node -------------------------------------------------------

function paragraphsFromText(text: string, href?: string): JSONContent[] {
  // One paragraph per line, what the table extension's own parseMarkdown
  // yields per cell. An empty cell is one empty paragraph — a cell is
  // `block+`, never empty.
  return text.split(/\r\n|\r|\n/).map((line) => {
    if (!line) return { type: "paragraph" };
    const textNode: JSONContent = { type: "text", text: line };
    if (href) textNode.marks = [{ type: "link", attrs: { href } }];
    return { type: "paragraph", content: [textNode] };
  });
}

function cellNode(cell: GridCell, header: boolean): JSONContent {
  const attrs: Record<string, number> = {};
  if (cell.colspan && cell.colspan > 1) attrs.colspan = cell.colspan;
  if (cell.rowspan && cell.rowspan > 1) attrs.rowspan = cell.rowspan;
  return {
    type: header ? "tableHeader" : "tableCell",
    ...(Object.keys(attrs).length ? { attrs } : {}),
    content: paragraphsFromText(cell.text, cell.href),
  };
}

/**
 * A `table` node in the shape `contentExtensions` accepts — the editor's
 * `insertContent` validates it against the live schema, so nothing here
 * needs one. Ragged rows are padded first; the first row is header cells
 * by default, matching the Markdown import.
 */
export function gridToTableJson(grid: TableGrid, { headerRow = true }: { headerRow?: boolean } = {}): JSONContent {
  const padded = padGrid(grid);
  if (padded.length === 0) throw new Error("The table has no rows.");
  return {
    type: "table",
    content: padded.map((row, r) => ({
      type: "tableRow",
      content: row.map((cell) => cellNode(cell, headerRow && r === 0)),
    })),
  };
}

// --- table node → grid -------------------------------------------------------

function textOfInline(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOfInline).join("");
}

// A cell's blocks, each as a line — a paragraph is its text, and anything
// else (a list, a nested table, a heading) is its paragraphs in order. Not a
// faithful rendering of a list or a nested table; the format has no room
// for either, and their text is what survives.
function linesOfBlock(node: JSONContent): string[] {
  if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
    return [(node.content ?? []).map(textOfInline).join("")];
  }
  return (node.content ?? []).flatMap(linesOfBlock);
}

function firstHref(node: JSONContent): string | undefined {
  for (const mark of node.marks ?? []) {
    if (mark.type === "link" && typeof mark.attrs?.href === "string") return mark.attrs.href;
  }
  for (const child of node.content ?? []) {
    const href = firstHref(child);
    if (href) return href;
  }
  return undefined;
}

/**
 * The grid a `table` node holds: text per cell with paragraphs joined by
 * "\n", spans kept, the first link's href kept, every other mark dropped.
 * A header cell is just row one — the grid has no header flag, and every
 * writer treats the first row as the header anyway.
 */
export function tableJsonToGrid(table: JSONContent): TableGrid {
  if (table.type !== "table") throw new Error(`Expected a table node, got ${table.type ?? "nothing"}.`);
  return (table.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => {
      const out: GridCell = { text: (cell.content ?? []).flatMap(linesOfBlock).join("\n") };
      const colspan = Number(cell.attrs?.colspan ?? 1);
      const rowspan = Number(cell.attrs?.rowspan ?? 1);
      if (colspan > 1) out.colspan = colspan;
      if (rowspan > 1) out.rowspan = rowspan;
      const href = firstHref(cell);
      if (href) out.href = href;
      return out;
    }),
  );
}
