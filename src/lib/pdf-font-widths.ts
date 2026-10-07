import type { MeasureText } from "./pdf-quads";
import { SANS_SERIF_WIDTHS, SERIF_WIDTHS, type WidthTable } from "./pdf-font-widths-data";

// docs/PDF_QUADS.md §2 — the advances a text item is measured in where no
// browser can measure it.
//
// pdfjs's text layer measures every item in one of three generic families
// (`styles[fontName].fontFamily`), in the regular face, then stretches the span
// to the item's width. So the ratios of the regular advances of whatever font a
// browser picks for `serif` and `sans-serif` are all it takes to place a
// character inside an item as that browser's selection would. These are
// Liberation Serif's and Liberation Sans's, metric-compatible with Times New
// Roman and Arial: Windows' defaults, and (Arial being Helvetica's metrics) the
// Mac's sans-serif. A reader whose fonts differ (Linux, through fontconfig)
// selects slightly elsewhere, and nothing on a server can know that.
//
// Pure and isomorphic. Kerning is not in the tables.

type Advances = { em: Map<number, number>; meanLowercase: number };

const cache = new Map<WidthTable, Advances>();

function advancesOf(table: WidthTable): Advances {
  let advances = cache.get(table);
  if (!advances) {
    const em = new Map<number, number>();
    for (const [first, ...widths] of table.runs) {
      widths.forEach((width, i) => em.set(first + i, width / table.unitsPerEm));
    }
    let sum = 0;
    for (let c = 0x61; c <= 0x7a; c++) sum += em.get(c) ?? 0;
    advances = { em, meanLowercase: sum / 26 };
    cache.set(table, advances);
  }
  return advances;
}

// East Asian wide and fullwidth characters, which any browser draws from a CJK
// font where they are one em. Neither Liberation font has them.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

function isWide(codePoint: number): boolean {
  return WIDE.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/**
 * The advance of `text` in ems, as a browser would measure it in `fontFamily`.
 * `monospace` counts characters, which is exact for every monospaced font. A
 * family that isn't one of the three generics is a font pdfjs couldn't load,
 * and a browser draws that in its default font, a serif unless the reader
 * changed it. A character the table lacks is one em if it is East Asian wide,
 * and otherwise the family's mean advance over a–z; a lone surrogate, from an
 * item sliced inside a pair, counts as such a character.
 */
export const standardWidths: MeasureText = (text, fontFamily) => {
  if (fontFamily === "monospace") return [...text].length;
  const { em, meanLowercase } = advancesOf(fontFamily === "sans-serif" ? SANS_SERIF_WIDTHS : SERIF_WIDTHS);
  let advance = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    advance += em.get(codePoint) ?? (isWide(codePoint) ? 1 : meanLowercase);
  }
  return advance;
};
