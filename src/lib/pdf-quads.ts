import { rectToQuad, type Quad } from "./pdf-anchor";
import { standardWidths } from "./pdf-font-widths";
import type { PdfTextItemLike, SourceOffset } from "./pdf-text";

// docs/PDF_QUADS.md — the quads of a range of a page's normalised text, from
// the page's text items alone, with no rendered text layer. Fragment links
// draw with it in the browser (docs/PDF_FRAGMENT_LINKS.md §6), and a server
// can compute a stored anchor's quads with it.
//
// `normalisePageText`'s `offsets` exist for exactly this: each character of
// the normalised text names the item and the character within it that it came
// from. A range therefore names, per item, a run of characters, and an item's
// transform, width and font metrics place that run on the page.
//
// Pure and isomorphic. Where a run starts and ends *inside* an item is the
// one thing the item can't say, since `width` is the whole item's advance. The
// text layer pdfjs draws answers it by measuring the item's string in a CSS
// font and scaling the span to fit `width`, so a selection in the viewer has
// its edges where that measurement puts them. Given a `measure` (the browser
// passes a canvas's `measureText`, in the reader's own fonts), this does the
// same and lands where a selection would. Without one (a server) it measures
// in `standardWidths`, the fonts Windows and the Mac draw those families in.
// Characters are spaced evenly only in an item that names no family, and in
// `monospace`, where even spacing is exact.

/**
 * A pdfjs text item as the normaliser takes it, with the font metrics
 * `getTextContent`'s `styles` carry for its font, so one array feeds both.
 */
export type QuadSourceItem = PdfTextItemLike & {
  /** The font's ascent and descent as fractions of its size; pdfjs's `styles[fontName]`. */
  ascent?: number;
  descent?: number;
  /** The CSS font family pdfjs's text layer draws this item in; `styles[fontName].fontFamily`. */
  fontFamily?: string;
};

/** The advance of `text` in `fontFamily`, at any one size; only ratios are used. */
export type MeasureText = (text: string, fontFamily: string) => number;

/** The parts of pdfjs's `getTextContent()` result that items are copied from. */
export type TextContentLike = {
  items: readonly ((PdfTextItemLike & { fontName: string }) | { type: string })[];
  styles: Readonly<Record<string, { ascent?: number; descent?: number; fontFamily?: string } | undefined>>;
};

/**
 * One page's text items with their fonts' metrics, from `getTextContent()`.
 * The browser and the server both copy through this, so the item list that
 * `normalisePageText`'s offsets index is the same list on both sides. Marked
 * content carries no text and is skipped, as pdfjs's text layer skips it, so
 * an item's index here is also its span's index in `TextLayer.textDivs`.
 *
 * Copied field by field into our own shape, which doubles as the explicit
 * statement of what the normaliser and the quads depend on: a pdfjs field
 * rename shows up here rather than as subtly different text.
 */
export function quadSourceItems(content: TextContentLike): QuadSourceItem[] {
  const items: QuadSourceItem[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const style = content.styles[item.fontName];
    items.push({
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      hasEOL: item.hasEOL,
      ascent: style?.ascent,
      descent: style?.descent,
      fontFamily: style?.fontFamily,
    });
  }
  return items;
}

// pdfjs's own fallback when a font reports no ascent (DEFAULT_FONT_ASCENT in
// its text layer), and the descent that leaves a 1em box.
const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;

// Two items' boxes are one line when their baselines are this close, as a
// fraction of the smaller font size, and the gap between them is less than
// this many font sizes. The second bound keeps a range that runs from one
// column into the next on the same baseline from becoming one box across the
// gutter.
const SAME_LINE_BASELINE = 0.5;
const SAME_LINE_GAP = 2;

type Box = { x0: number; y0: number; x1: number; y1: number; baseline: number; size: number };

/**
 * One quad per line the range covers, in PDF user space and `/QuadPoints`
 * order, as a selection in the viewer produces them (docs/PDF.md §5). Empty
 * when the range covers no glyph: an inserted separator stands for a gap,
 * not a character, so a range of nothing but separators has nothing to draw.
 */
export function quadsForRange(
  items: readonly QuadSourceItem[],
  offsets: readonly SourceOffset[],
  start: number,
  end: number,
  measure: MeasureText = standardWidths,
): Quad[] {
  // The run each item contributes, as [lo, hi) within its own string.
  const runs = new Map<number, { lo: number; hi: number }>();
  for (let i = Math.max(0, start); i < Math.min(end, offsets.length); i++) {
    const { itemIndex, charOffset } = offsets[i];
    const item = items[itemIndex];
    // A separator `normalisePageText` inserted is attributed to one past its
    // item's last character: a gap, which a box needn't cover.
    if (!item || charOffset >= item.str.length) continue;
    const run = runs.get(itemIndex);
    if (run) {
      run.lo = Math.min(run.lo, charOffset);
      run.hi = Math.max(run.hi, charOffset + 1);
    } else {
      runs.set(itemIndex, { lo: charOffset, hi: charOffset + 1 });
    }
  }

  const quads: Quad[] = [];
  let line: Box | null = null;
  const flush = () => {
    if (line && line.x1 - line.x0 > 0 && line.y1 - line.y0 > 0) {
      quads.push(rectToQuad(line.x0, line.y0, line.x1, line.y1));
    }
    line = null;
  };

  for (const [itemIndex, run] of [...runs].sort((a, b) => a[0] - b[0])) {
    const item = items[itemIndex];
    const geometry = itemGeometry(item, run.lo, run.hi, measure);
    if (geometry.kind === "rotated") {
      flush();
      quads.push(geometry.quad);
      continue;
    }
    const box = geometry.box;
    const current: Box | null = line;
    if (
      current &&
      Math.abs(current.baseline - box.baseline) < SAME_LINE_BASELINE * Math.min(current.size, box.size) &&
      box.x0 - current.x1 < SAME_LINE_GAP * Math.min(current.size, box.size) &&
      box.x1 > current.x0
    ) {
      current.x0 = Math.min(current.x0, box.x0);
      current.x1 = Math.max(current.x1, box.x1);
      current.y0 = Math.min(current.y0, box.y0);
      current.y1 = Math.max(current.y1, box.y1);
    } else {
      flush();
      line = box;
    }
  }
  flush();
  return quads;
}

type Geometry = { kind: "box"; box: Box } | { kind: "rotated"; quad: Quad };

/** Where characters [lo, hi) of one item sit. */
function itemGeometry(item: QuadSourceItem, lo: number, hi: number, measure: MeasureText): Geometry {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
  const size = Math.hypot(c, d) || item.height || 1;
  const along = Math.hypot(a, b);
  const dir = along > 0 ? [a / along, b / along] : [1, 0];
  const upLength = Math.hypot(c, d);
  const up = upLength > 0 ? [c / upLength, d / upLength] : [-dir[1], dir[0]];

  const [from, to] = runFractions(item, lo, hi, measure);
  const t0 = item.width * from;
  const t1 = item.width * to;
  const s0 = (item.descent ?? DEFAULT_DESCENT) * size;
  const s1 = (item.ascent ?? DEFAULT_ASCENT) * size;

  const horizontal = Math.abs(dir[1]) < 1e-6 && Math.abs(up[0]) < 1e-6 && dir[0] > 0 && up[1] > 0;
  if (horizontal) {
    return { kind: "box", box: { x0: e + t0, x1: e + t1, y0: f + s0, y1: f + s1, baseline: f, size } };
  }
  const at = (t: number, s: number): [number, number] => [e + t * dir[0] + s * up[0], f + t * dir[1] + s * up[1]];
  return { kind: "rotated", quad: [...at(t0, s1), ...at(t1, s1), ...at(t0, s0), ...at(t1, s0)] as Quad };
}

/** Characters [lo, hi) as fractions of the item's advance: measured in the item's font family, even when it names none. */
function runFractions(item: QuadSourceItem, lo: number, hi: number, measure: MeasureText): [number, number] {
  const length = item.str.length || 1;
  if (item.fontFamily) {
    const whole = measure(item.str, item.fontFamily);
    if (whole > 0) {
      return [measure(item.str.slice(0, lo), item.fontFamily) / whole, measure(item.str.slice(0, hi), item.fontFamily) / whole];
    }
  }
  return [lo / length, hi / length];
}
