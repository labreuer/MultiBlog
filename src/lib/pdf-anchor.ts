// PLAN.md §19 / docs/PDF.md §2 — what a PDF annotation points at, and the one
// place that decides whether a given blob is a valid one.
//
// Isomorphic and dependency-free: the browser builds these, the server
// validates and stores them, and `scripts/integrity/check-pdf-anchors.ts`
// re-reads them. Nothing pdfjs-specific appears in the stored shape, which is
// docs/PDF.md invariant 3 — swapping renderers must be a rendering change, not
// a data migration.

/**
 * One quadrilateral in **PDF user space**: points, origin bottom-left, y
 * increasing upward, in `/QuadPoints` order. Same convention a real PDF
 * annotation uses, which is why this is the primary anchor rather than the
 * quote (docs/PDF.md §1: two renderers extract text differently, but they
 * agree about geometry).
 */
export type Quad = [number, number, number, number, number, number, number, number];

export type PdfTarget = {
  /** 0-based. */
  pageIndex: number;
  /**
   * PRIMARY anchor — one quad per rendered line fragment. `range.getClientRects()`
   * returns one rect per line, not one per selection, and storing all of them
   * separately is what makes a multi-line highlight draw correctly rather than
   * as one box swallowing the intervening text (docs/PDF.md §5).
   */
  quads: Quad[];
  /**
   * CHECK — used to verify a resolved location is still the right text.
   * `exact` is "" for a rectangle selection over a figure, where there is no
   * text to quote and the quads are the whole anchor.
   */
  quote: { exact: string; prefix: string; suffix: string };
  /**
   * HINT ONLY — character offsets into the page's normalised text
   * (src/lib/pdf-text.ts). Never authoritative, and null for a rectangle
   * selection. It is what makes the server-side `quotedText` derivation a
   * string slice instead of a re-parse.
   */
  position: { start: number; end: number } | null;
  /** `${pdfjsVersion}/${normaliserVersion}` — see src/lib/pdf-text.ts. */
  textVersion: string;
};

/** ~32 characters either side, per docs/PDF.md §2. Enough to disambiguate a repeated phrase. */
export const QUOTE_CONTEXT_LENGTH = 32;

/**
 * Narrows an untrusted value (a server-action argument, a stored JSON column)
 * to a `PdfTarget`.
 *
 * Deliberately strict about shape and loose about *values*: it checks that
 * every number is finite and that the arrays have the right arity, but it does
 * not check that the quads fall inside the page or that the quote matches. The
 * first would need the page dimensions, which this module has no business
 * knowing; the second is the server's job at post time, against the stored page
 * text, and is where the real trust boundary lives (§12i's "a request field
 * only, never a column" — nothing a client sends here is stored verbatim).
 */
export function parsePdfTarget(value: unknown): PdfTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  if (!Number.isInteger(raw.pageIndex) || (raw.pageIndex as number) < 0) return null;
  if (typeof raw.textVersion !== "string" || raw.textVersion === "") return null;

  if (!Array.isArray(raw.quads) || raw.quads.length === 0) return null;
  const quads: Quad[] = [];
  for (const candidate of raw.quads) {
    if (!Array.isArray(candidate) || candidate.length !== 8) return null;
    if (!candidate.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    quads.push(candidate as Quad);
  }

  const quote = raw.quote as Record<string, unknown> | undefined;
  if (typeof quote !== "object" || quote === null) return null;
  if (typeof quote.exact !== "string" || typeof quote.prefix !== "string" || typeof quote.suffix !== "string") {
    return null;
  }

  let position: PdfTarget["position"] = null;
  if (raw.position !== null && raw.position !== undefined) {
    const p = raw.position as Record<string, unknown>;
    if (!Number.isInteger(p.start) || !Number.isInteger(p.end)) return null;
    const start = p.start as number;
    const end = p.end as number;
    if (start < 0 || end < start) return null;
    position = { start, end };
  }

  return {
    pageIndex: raw.pageIndex as number,
    quads,
    quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
    position,
    textVersion: raw.textVersion,
  };
}

/**
 * The axis-aligned bounding box of a set of quads, in PDF user space.
 *
 * Used for "where is this annotation, roughly" — the rail tick, the jump
 * target — never for drawing the highlight itself, which uses every quad
 * separately so a multi-line selection doesn't become one rectangle covering
 * the whole paragraph.
 */
export function quadsBounds(quads: readonly Quad[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (quads.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const quad of quads) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, quad[i]);
      x1 = Math.max(x1, quad[i]);
      y0 = Math.min(y0, quad[i + 1]);
      y1 = Math.max(y1, quad[i + 1]);
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * The quads' **top** edge, in PDF user space (largest y, since y increases
 * upward). This is the value a rail converts to a document fraction, and the
 * sign confusion it exists to contain is real: everything DOM-side measures
 * downward from a page's top edge, and everything stored measures upward from
 * its bottom.
 */
export function quadsTopY(quads: readonly Quad[]): number | null {
  const bounds = quadsBounds(quads);
  return bounds ? bounds.y1 : null;
}

/** A rectangle in PDF user space as a `/QuadPoints`-ordered quad. */
export function rectToQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const bottom = Math.min(y0, y1);
  const top = Math.max(y0, y1);
  // /QuadPoints order is (upper-left, upper-right, lower-left, lower-right) —
  // *not* a clockwise or counter-clockwise walk, which is the mistake to avoid
  // when reading this back.
  return [left, top, right, top, left, bottom, right, bottom];
}
