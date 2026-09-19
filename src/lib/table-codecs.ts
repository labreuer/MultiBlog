// PLAN.md §24c — the format table: which files a table can be read from
// and written to, one codec per format over the TableGrid. Everything
// that names a format — the menu's file picker `accept`, the editor's drop
// handler, the download items — reads this list rather than spelling
// ".csv" itself, so adding a format is one entry here.
//
// Each codec's module is reached through a dynamic `import()`, at the
// moment of use. For CSV, sixty lines, that is a formality; it is the shape
// an xlsx codec needs, since its library is not free and belongs in no
// page's initial bundle (docs/research/tables.md, "Bundle weight is the
// placement question CSV never had"). Client-only: there is no server path
// — a table file goes into an *existing* doc through the editor, never
// into a new doc through /docs' importer, which stays Markdown.

import { type TableGrid, assertGridWithinCap, gridToRectangle, rectangleToGrid, padGrid } from "./table-grid";

export type TableCodec = {
  // Lowercase, with the dot.
  extensions: string[];
  // As the menu names it: "Download as CSV".
  label: string;
  mime: string;
  read(file: File): Promise<TableGrid>;
  write(grid: TableGrid): Promise<Blob>;
};

const csvCodec: TableCodec = {
  extensions: [".csv"],
  label: "CSV",
  mime: "text/csv;charset=utf-8",
  async read(file) {
    const { parseCsv } = await import("./csv");
    // .text() decodes as UTF-8 whatever the file is. Excel's *default*
    // "CSV" export is the legacy code page and arrives mojibaked rather
    // than rejected; "CSV UTF-8" is the one to choose, and the Markdown
    // importer made the same call for the same reason.
    return rectangleToGrid(parseCsv(await file.text()));
  },
  async write(grid) {
    const { formatCsv } = await import("./csv");
    return new Blob([formatCsv(gridToRectangle(padGrid(grid)))], { type: csvCodec.mime });
  },
};

export const TABLE_CODECS: TableCodec[] = [csvCodec];

/** The file input's `accept` attribute: every codec's extensions. */
export const TABLE_FILE_ACCEPT = TABLE_CODECS.flatMap((c) => c.extensions).join(",");

// A sanity limit before a file is read into memory at all. Not the guard
// that matters — MAX_TABLE_CELLS is, after decode — but nothing upstream
// bounds a file the user picks or drops, and a gigabyte of text should not
// reach `file.text()`.
export const MAX_TABLE_FILE_BYTES = 4 * 1024 * 1024;

export function codecForFile(name: string): TableCodec | null {
  const lowered = name.toLowerCase();
  return TABLE_CODECS.find((c) => c.extensions.some((ext) => lowered.endsWith(ext))) ?? null;
}

export type ReadTableResult = { ok: true; grid: TableGrid } | { ok: false; error: string };

/**
 * A file to a grid, or a message in the style /docs' importer uses. The
 * caller decides what a grid becomes (a node at the caret, a node at a
 * drop point); every rejection a user can cause is answered here.
 */
export async function readTableFile(file: File): Promise<ReadTableResult> {
  const codec = codecForFile(file.name);
  if (!codec) {
    return { ok: false, error: `${file.name} isn't a table file (expected ${TABLE_FILE_ACCEPT.split(",").join(", ")}).` };
  }
  if (file.size > MAX_TABLE_FILE_BYTES) {
    return {
      ok: false,
      error: `${file.name} is ${Math.round(file.size / 1024)} KB — the table import limit is ${Math.round(MAX_TABLE_FILE_BYTES / 1024)} KB.`,
    };
  }
  let grid: TableGrid;
  try {
    grid = await codec.read(file);
  } catch (err) {
    return { ok: false, error: `Couldn't read ${file.name}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    assertGridWithinCap(grid);
  } catch (err) {
    return { ok: false, error: `${file.name}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, grid };
}
