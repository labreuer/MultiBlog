// Writes src/lib/pdf-font-widths-data.ts: the advance of every character
// Liberation Serif and Liberation Sans map, which `standardWidths` measures a
// PDF text item with where no browser can (docs/PDF_QUADS.md §2).
//
// Reads the TTFs' own tables (`head`, `hhea`, `name`, `cmap`, `hmtx`) rather
// than measuring on a canvas, because a canvas gives a plausible width for a
// character the font lacks (its missing-glyph box) and so can't say which
// characters the table holds. The regular faces only: pdfjs's text layer
// measures every item in the regular weight.
//
// The output is committed; nothing runs this at build time. Rerun it only to
// change fonts, and expect `pdf-font-widths.test.ts` to name what moved.
//
// Usage:
//   npx tsx scripts/generate-pdf-font-widths.ts [--serif <ttf>] [--sans <ttf>]
//   Defaults are Fedora's paths for liberation-serif-fonts and
//   liberation-sans-fonts.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
  serif: "/usr/share/fonts/liberation-serif-fonts/LiberationSerif-Regular.ttf",
  sans: "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf",
};
const OUTPUT = join(process.cwd(), "src/lib/pdf-font-widths-data.ts");
const NUMBERS_PER_LINE = 16;

type Font = { name: string; version: string; unitsPerEm: number; advances: Map<number, number> };

function argument(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function readFont(path: string): Font {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    tables.set(tag, view.getUint32(record + 8));
  }
  const table = (tag: string) => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`${path} has no '${tag}' table.`);
    return offset;
  };

  const unitsPerEm = view.getUint16(table("head") + 18);
  const numberOfHMetrics = view.getUint16(table("hhea") + 34);
  const hmtx = table("hmtx");
  const advanceOf = (glyph: number) => view.getUint16(hmtx + Math.min(glyph, numberOfHMetrics - 1) * 4);

  const advances = new Map<number, number>();
  for (const [codePoint, glyph] of characterMap(view, table("cmap"))) {
    if (glyph !== 0) advances.set(codePoint, advanceOf(glyph));
  }
  return { name: nameString(view, table("name"), 4), version: nameString(view, table("name"), 5), unitsPerEm, advances };
}

/** Code point → glyph, from the Windows Unicode subtable: format 12 if present, else format 4. */
function characterMap(view: DataView, cmap: number): Map<number, number> {
  const subtables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    subtables.set(`${view.getUint16(record)}/${view.getUint16(record + 2)}`, cmap + view.getUint32(record + 4));
  }
  const map = new Map<number, number>();
  const full = subtables.get("3/10");
  if (full !== undefined && view.getUint16(full) === 12) {
    const groups = view.getUint32(full + 12);
    for (let i = 0; i < groups; i++) {
      const group = full + 16 + i * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const glyph = view.getUint32(group + 8);
      for (let c = start; c <= end; c++) map.set(c, glyph + (c - start));
    }
    return map;
  }
  const bmp = subtables.get("3/1");
  if (bmp === undefined || view.getUint16(bmp) !== 4) throw new Error("No Windows Unicode cmap subtable in format 4 or 12.");
  const segments = view.getUint16(bmp + 6) / 2;
  const ends = bmp + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let i = 0; i < segments; i++) {
    const start = view.getUint16(starts + i * 2);
    const end = view.getUint16(ends + i * 2);
    const delta = view.getUint16(deltas + i * 2);
    const rangeOffset = view.getUint16(rangeOffsets + i * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (c + delta) & 0xffff;
      } else {
        const raw = view.getUint16(rangeOffsets + i * 2 + rangeOffset + (c - start) * 2);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      map.set(c, glyph);
    }
  }
  return map;
}

/** A `name` table entry, from its Windows (UTF-16BE) record. */
function nameString(view: DataView, name: number, nameId: number): string {
  const count = view.getUint16(name + 2);
  const storage = name + view.getUint16(name + 4);
  for (let i = 0; i < count; i++) {
    const record = name + 6 + i * 12;
    if (view.getUint16(record) !== 3 || view.getUint16(record + 6) !== nameId) continue;
    const length = view.getUint16(record + 8);
    const offset = storage + view.getUint16(record + 10);
    let text = "";
    for (let j = 0; j < length; j += 2) text += String.fromCharCode(view.getUint16(offset + j));
    return text;
  }
  throw new Error(`No Windows name record ${nameId}.`);
}

/** Runs of consecutive code points, each `[first, advance, advance, …]`. */
function runsOf(advances: Map<number, number>): number[][] {
  const runs: number[][] = [];
  let run: number[] | null = null;
  let next = -1;
  for (const codePoint of [...advances.keys()].sort((a, b) => a - b)) {
    if (!run || codePoint !== next) {
      run = [codePoint];
      runs.push(run);
    }
    run.push(advances.get(codePoint)!);
    next = codePoint + 1;
  }
  return runs;
}

function tableSource(constant: string, font: Font): string {
  const runs = runsOf(font.advances)
    .map((run) => {
      const lines: string[] = [];
      for (let i = 0; i < run.length; i += NUMBERS_PER_LINE) lines.push(run.slice(i, i + NUMBERS_PER_LINE).join(", "));
      return `    [\n      ${lines.join(",\n      ")},\n    ],`;
    })
    .join("\n");
  return [
    `/** ${font.name}, ${font.version}: ${font.advances.size} characters. */`,
    `export const ${constant}: WidthTable = {`,
    `  unitsPerEm: ${font.unitsPerEm},`,
    `  runs: [`,
    runs,
    `  ],`,
    `};`,
  ].join("\n");
}

const serif = readFont(argument("--serif") ?? DEFAULTS.serif);
const sans = readFont(argument("--sans") ?? DEFAULTS.sans);

writeFileSync(
  OUTPUT,
  [
    `// Generated by scripts/generate-pdf-font-widths.ts; do not edit by hand.`,
    `// docs/PDF_QUADS.md §2. Regenerate with:`,
    `//   npx tsx scripts/generate-pdf-font-widths.ts`,
    ``,
    `/** Advances in font units, as runs of consecutive code points: \`[first, advance, advance, …]\`. */`,
    `export type WidthTable = { unitsPerEm: number; runs: readonly (readonly number[])[] };`,
    ``,
    tableSource("SERIF_WIDTHS", serif),
    ``,
    tableSource("SANS_SERIF_WIDTHS", sans),
    ``,
  ].join("\n"),
);
console.log(`Wrote ${OUTPUT}: ${serif.name} ${serif.advances.size}, ${sans.name} ${sans.advances.size} characters.`);
