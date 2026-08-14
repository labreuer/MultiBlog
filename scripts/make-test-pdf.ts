// A minimal, dependency-free PDF writer — enough of the format to produce a
// real multi-page document with real, extractable text (PLAN.md §19).
//
// Why hand-roll rather than commit a fixture PDF: the e2e suite needs to
// *assert on the text it selects*, so the fixture and the expectation have to
// come from one place. A binary checked into the repo would put the two a
// rebuild apart, and a real-world PDF would drag in fonts, compression and
// structure that make a failure hard to attribute — when a viewer test breaks,
// "is the fixture weird?" should never be a live hypothesis. It also keeps the
// repo free of a binary blob whose provenance nobody can check.
//
// Deliberately the *simplest* PDF that exercises what we care about:
// uncompressed content streams, one standard Type1 font (so no font program is
// embedded and no font data has to be fetched), and one text-showing operator
// per line. That is exactly the surface src/lib/pdf-text.ts reads. It is not a
// substitute for testing against a real-world PDF by hand — ligatures, kerned
// gaps and multi-column reading order are the things this cannot reproduce.
//
// Usage: `npx tsx scripts/make-test-pdf.ts out.pdf` writes the three-page
// sample; the e2e fixtures import buildTestPdf directly.

import { writeFileSync } from "node:fs";

/** Font size and leading used for every line — the viewer specs measure against these. */
const FONT_SIZE = 14;
const LINE_HEIGHT = 22;
const MARGIN_LEFT = 72;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const TOP_BASELINE = PAGE_HEIGHT - 72;

/** Escapes the three characters that are special inside a PDF literal string. */
function escapePdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function contentStreamFor(lines: readonly string[]): string {
  const shown = lines
    .map((line, index) => {
      const y = TOP_BASELINE - index * LINE_HEIGHT;
      return `BT /F1 ${FONT_SIZE} Tf ${MARGIN_LEFT} ${y} Td (${escapePdfString(line)}) Tj ET`;
    })
    .join("\n");
  return `${shown}\n`;
}

/**
 * Builds a PDF whose page `i` contains `pages[i]`, one line per array entry.
 *
 * The output is a valid PDF 1.4 with a correct cross-reference table — pdfjs
 * will reconstruct a broken xref rather than fail, so getting it right here is
 * what keeps this a test of *our* extraction rather than of pdfjs's recovery
 * path.
 */
export function buildTestPdf(pages: readonly (readonly string[])[]): Uint8Array {
  if (pages.length === 0) throw new Error("buildTestPdf needs at least one page.");

  // Object numbering: 1 = catalog, 2 = pages tree, 3 = font, then a page and a
  // content stream per page, interleaved.
  const CATALOG = 1;
  const PAGES = 2;
  const FONT = 3;
  const firstPageObj = 4;
  const pageObjNumber = (i: number) => firstPageObj + i * 2;
  const contentObjNumber = (i: number) => firstPageObj + i * 2 + 1;

  const objects = new Map<number, string>();
  objects.set(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  objects.set(
    PAGES,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObjNumber(i)} 0 R`).join(" ")}] >>`,
  );
  objects.set(FONT, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);

  pages.forEach((lines, i) => {
    objects.set(
      pageObjNumber(i),
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${contentObjNumber(i)} 0 R >>`,
    );
    const stream = contentStreamFor(lines);
    objects.set(
      contentObjNumber(i),
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
    );
  });

  // Assemble, recording each object's byte offset for the xref table. Built as
  // latin1 throughout: a PDF's structure is bytes, not characters, and every
  // offset below is a byte offset.
  const header = "%PDF-1.4\n";
  const chunks: string[] = [header];
  let offset = Buffer.byteLength(header, "latin1");
  const offsets = new Map<number, number>();

  const objectNumbers = [...objects.keys()].sort((a, b) => a - b);
  for (const number of objectNumbers) {
    offsets.set(number, offset);
    const body = `${number} 0 obj\n${objects.get(number)}\nendobj\n`;
    chunks.push(body);
    offset += Buffer.byteLength(body, "latin1");
  }

  const xrefOffset = offset;
  const total = objectNumbers.length + 1; // +1 for the mandatory free object 0
  // Every xref entry is exactly 20 bytes, including its two-character EOL —
  // the one part of this format that silently breaks a reader if miscounted.
  const entries = [`${"0".repeat(10)} ${"65535".padStart(5, "0")} f \n`];
  for (const number of objectNumbers) {
    entries.push(`${String(offsets.get(number)).padStart(10, "0")} ${"00000"} n \n`);
  }
  chunks.push(`xref\n0 ${total}\n${entries.join("")}`);
  chunks.push(`trailer\n<< /Size ${total} /Root ${CATALOG} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
}

/** The sample document the e2e suite and `npx tsx scripts/make-test-pdf.ts` both use. */
export const SAMPLE_PDF_PAGES: readonly (readonly string[])[] = [
  [
    "The quick brown fox jumps over the lazy dog.",
    "This first page exists so a selection can be made and anchored.",
    "A distinctive phrase for page one: heliotrope cartwheel.",
  ],
  [
    "Page two begins here, well past the first screenful.",
    "It is here so that scrolling and page changes can be tested.",
    "A distinctive phrase for page two: xylophone marmalade.",
  ],
  [
    "Page three is the tail of the document.",
    "A distinctive phrase for page three: quixotic barnacle.",
  ],
];

// CLI entry, for dumping a sample to disk when driving the viewer by hand.
// Guarded on argv rather than `require.main === module` or `import.meta.url`:
// this file is imported by the e2e fixtures *and* run by tsx, which transpiles
// to CJS (no top-level await, no import.meta) while Next's own build is ESM.
// An argv check is the one test that works under both.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/make-test-pdf.ts")) {
  const out = process.argv[2] ?? "test.pdf";
  writeFileSync(out, buildTestPdf(SAMPLE_PDF_PAGES));
  console.log(`Wrote ${out}`);
}
