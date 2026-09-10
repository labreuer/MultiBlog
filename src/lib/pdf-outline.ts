// PLAN.md §19b — the DOM-free, pdfjs-free half of the Contents pane.
//
// Split out for the reason src/lib/pdf-geometry.ts is: the component measures
// and renders, this decides. Everything here is a pure function over plain
// data, so the whole set of answers that matter — a malformed destination, an
// outline that points backwards, a collapsed subtree containing the reader's
// position — is a table in pdf-outline.test.ts rather than a browser session.
//
// The one thing this file deliberately does *not* do is resolve a page ref to
// a page index. That is a worker round trip and belongs to the hook
// (use-pdf-outline.ts); what arrives here is already numeric.

/**
 * One entry of pdfjs's `pdf.getOutline()`, as much of it as we read.
 *
 * Declared here rather than imported: pdfjs-dist's generated `.d.ts` elides
 * the recursion (`items: Array<any>`), so the shipped type cannot describe a
 * tree at all. Structural typing means a real pdfjs node still satisfies this.
 */
export type PdfOutlineItem = {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  /**
   * The PDF's own `/Count` for the entry. **Its sign is the author's
   * open/closed choice** (PDF 32000-1 §12.3.3: negative means the subtree is
   * closed when the document opens), which is what `defaultExpanded` reads.
   * Absent for a leaf.
   */
  count?: number;
  items?: PdfOutlineItem[];
};

/** Where an entry points, in the unrotated scale-1 space every fraction uses. */
export type OutlinePosition = {
  pageIndex: number;
  /** Points **down** from the page's top edge — not PDF user space. */
  yFromTop: number;
};

/**
 * One row of the rendered tree.
 *
 * Flat, with parent links, rather than nested: every question the pane asks —
 * which row is active, which of its ancestors is visible, what the next row
 * down is for the arrow keys — is a scan or a lookup, and none of them is
 * naturally a walk. The nesting is recoverable from `id` alone (see below), and
 * the pane renders it flat — `levelPositions` says what that costs in ARIA.
 */
export type OutlineNode = {
  /**
   * The node's path from the root, as `"0.2.1"`.
   *
   * **The ancestor chain is derivable from the id**, which is what lets
   * `visibleAncestorOf` answer without a tree walk and what makes the expanded
   * set a plain `Set<string>` that survives an outline reload unchanged.
   */
  id: string;
  parentId: string | null;
  /** 0 for a top-level entry. Also the `aria-level` minus one. */
  depth: number;
  title: string;
  /** Passed back to `PDFLinkService.goToDestination` untouched — see below. */
  dest: string | unknown[] | null;
  /** An outline entry can point at a URL instead of a place in the document. */
  url: string | null;
  /**
   * Where in the document this lands, or null when the destination could not be
   * resolved (a broken dest, a named destination the document doesn't define,
   * or a `url` entry that was never a place in this file).
   *
   * A null position costs the entry only its *highlight*: it still renders, and
   * it is still clickable if it has a `dest`, because pdfjs's own resolver may
   * well succeed where our page-ref lookup gave up.
   */
  position: OutlinePosition | null;
  /** 0..1 down the whole document — null exactly when `position` is. */
  fraction: number | null;
  /** The PDF's own open/closed hint; see `PdfOutlineItem.count`. */
  count?: number;
  hasChildren: boolean;
};

/** The id of `index`'th child of `parentId` — the one place the format is written. */
function childId(parentId: string | null, index: number): string {
  return parentId === null ? String(index) : `${parentId}.${index}`;
}

/**
 * Every ancestor of `id`, outermost first, not including `id` itself.
 *
 * String surgery on the path rather than a tree lookup, deliberately: this runs
 * once per rendered row per render, and it must keep working for an id whose
 * node has since been re-flattened away (an outline reload, a different file).
 */
export function ancestorIdsOf(id: string): string[] {
  const parts = id.split(".");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("."));
  return out;
}

/** Flattens pdfjs's tree into rows, assigning each its path id and depth. */
export function flattenOutline(
  items: readonly PdfOutlineItem[],
  positionOf: (item: PdfOutlineItem) => OutlinePosition | null,
  fractionOf: (position: OutlinePosition) => number,
): OutlineNode[] {
  const out: OutlineNode[] = [];

  const walk = (level: readonly PdfOutlineItem[], parentId: string | null, depth: number) => {
    level.forEach((item, index) => {
      const id = childId(parentId, index);
      const position = positionOf(item);
      out.push({
        id,
        parentId,
        depth,
        // A title is a PDF text string and can be empty, or whitespace only.
        // Left as-is beyond trimming: the pane renders a fallback, and
        // inventing one here would put it in the accessible name too.
        title: item.title.trim(),
        dest: item.dest ?? null,
        url: item.url ?? null,
        position,
        fraction: position ? fractionOf(position) : null,
        count: item.count,
        hasChildren: (item.items?.length ?? 0) > 0,
      });
      if (item.items?.length) walk(item.items, id, depth + 1);
    });
  };

  walk(items, null, 0);
  return out;
}

/**
 * Each row's place among its siblings, as ARIA's 1-based `aria-posinset` and
 * `aria-setsize`.
 *
 * The pane renders the tree **flat** — every visible row a sibling in the DOM,
 * nesting expressed by `aria-level` and indentation rather than by nested
 * `role="group"` elements. ARIA allows either, and flat is what keeps a focus
 * ring around one row instead of around a row *and* everything under it. The
 * cost is that set position stops being implicit in the DOM and has to be
 * stated, which is what this computes.
 */
export function levelPositions(nodes: readonly OutlineNode[]): Map<string, { posInSet: number; setSize: number }> {
  const counts = new Map<string, number>();
  const key = (parentId: string | null) => parentId ?? "";
  for (const node of nodes) counts.set(key(node.parentId), (counts.get(key(node.parentId)) ?? 0) + 1);

  const seen = new Map<string, number>();
  const out = new Map<string, { posInSet: number; setSize: number }>();
  for (const node of nodes) {
    const posInSet = (seen.get(key(node.parentId)) ?? 0) + 1;
    seen.set(key(node.parentId), posInSet);
    out.set(node.id, { posInSet, setSize: counts.get(key(node.parentId)) ?? 1 });
  }
  return out;
}

/**
 * The set of ids expanded when the pane first opens.
 *
 * Honours the PDF's own `/Count` sign throughout — an author who shipped a
 * 400-entry outline collapsed to its parts meant it, and a top-level chapter
 * that ships closed is the ordinary way a long document keeps its contents
 * readable.
 *
 * The one override is for the document that ships **everything** closed, where
 * honouring it literally gives a pane of rows with nothing under any of them
 * and no clue that there is more: then the top level opens. Not a general
 * "always expand the first level", which would overrule the far more common
 * deliberate case above.
 */
export function defaultExpanded(nodes: readonly OutlineNode[]): Set<string> {
  const expanded = new Set<string>();
  let anyParents = false;
  for (const node of nodes) {
    if (!node.hasChildren) continue;
    anyParents = true;
    if ((node.count ?? 0) > 0) expanded.add(node.id);
  }
  if (expanded.size > 0 || !anyParents) return expanded;
  for (const node of nodes) {
    if (node.depth === 0 && node.hasChildren) expanded.add(node.id);
  }
  return expanded;
}

/**
 * Whether a row is rendered at all: every one of its ancestors is expanded.
 *
 * (A row's *own* expanded state says whether its children show, never whether
 * it does.)
 */
export function isVisible(id: string, expanded: ReadonlySet<string>): boolean {
  return ancestorIdsOf(id).every((ancestor) => expanded.has(ancestor));
}

/** The rendered rows, in the order they appear — what the arrow keys move over. */
export function visibleOrder(nodes: readonly OutlineNode[], expanded: ReadonlySet<string>): OutlineNode[] {
  return nodes.filter((node) => isVisible(node.id, expanded));
}

/**
 * Which entry the reader is inside, given where the reading line has got to.
 *
 * **The last entry at or above the line, deepest first on a tie** — so a
 * section stays current until the next heading begins, however far down the
 * document that is. The obvious alternative, "the first heading visible in the
 * viewport", highlights nothing at all in the middle of a long section, which
 * is most of the time in exactly the documents that have an outline.
 *
 * Entries are compared by fraction rather than by document order because an
 * outline is not obliged to be monotonic — a badly-generated one can point a
 * later entry at an earlier page, and ordering by the tree would then make the
 * highlight jump backwards while the reader scrolls forwards.
 *
 * Returns null when the reader is above the first entry (a title page before
 * chapter one) — which is a real answer, not a failure, and renders as no
 * highlight.
 */
export function activeNodeAt(nodes: readonly OutlineNode[], fraction: number): OutlineNode | null {
  let best: OutlineNode | null = null;
  let bestFraction = -1;
  for (const node of nodes) {
    if (node.fraction === null || node.fraction > fraction) continue;
    // Same fraction — a chapter and its first section share a page top far
    // more often than not. The deeper entry is the more specific answer, and
    // the shallower one still lights up as its ancestor.
    const better =
      best === null || node.fraction > bestFraction || (node.fraction === bestFraction && node.depth > best.depth);
    if (better) {
      best = node;
      bestFraction = node.fraction;
    }
  }
  return best;
}

/**
 * The row that carries the highlight, given which one is really active.
 *
 * When the active entry is inside a collapsed subtree it is not on screen, so
 * the highlight goes to the outermost collapsed ancestor — the row the reader
 * would have to open to find it. That is the whole point of the feature: a
 * collapsed "Chapter 4" lights up while you read §4.2.
 *
 * Deliberately **no auto-expanding**. Opening the tree to follow the scroll
 * would remove the case this exists for, and it moves rows under the reader's
 * pointer while they are trying to click one.
 */
export function visibleAncestorOf(activeId: string, expanded: ReadonlySet<string>): string {
  for (const ancestor of ancestorIdsOf(activeId)) {
    if (!expanded.has(ancestor)) return ancestor;
  }
  return activeId;
}

/**
 * A PDF destination array's landing point on its page, as points **down** from
 * the page's top edge.
 *
 * The shape is `[pageRefOrIndex, {name}, ...args]`, and which arg carries the y
 * — if any — depends on the name (PDF 32000-1 §12.3.2.2):
 *
 * - `XYZ`   `[…, /XYZ, left, top, zoom]` → `top`, which may be null for "keep"
 * - `FitH`  `[…, /FitH, top]`            → `top`
 * - `FitBH` `[…, /FitBH, top]`           → `top`
 * - `FitR`  `[…, /FitR, l, b, r, t]`     → `t`, the rectangle's top edge
 * - `Fit`, `FitB`, `FitV`, `FitBV`       → no vertical position at all
 *
 * A missing or unusable y means the page's top, which is what pdfjs scrolls to
 * as well — so the highlight and the jump agree rather than differing by a
 * screenful.
 */
export function destinationYFromTop(dest: readonly unknown[], pageHeight: number): number {
  const name = destName(dest[1]);
  const raw =
    name === "XYZ" ? dest[3] : name === "FitH" || name === "FitBH" ? dest[2] : name === "FitR" ? dest[5] : null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  // PDF user space measures y *upward* from the page's bottom edge; a
  // yFromTop measures downward from its top. This subtraction is the whole
  // conversion, and getting it backwards lands every entry a mirror image of
  // where it belongs — which looks like an off-by-a-bit, not like a sign error.
  const fromTop = pageHeight - raw;
  return fromTop < 0 ? 0 : fromTop > pageHeight ? pageHeight : fromTop;
}

/** pdfjs hands the destination *type* over as `{ name: "XYZ" }`. */
function destName(entry: unknown): string | null {
  if (entry && typeof entry === "object" && "name" in entry) {
    const name = (entry as { name: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  // A name can also arrive as a bare string from a hand-rolled destination.
  return typeof entry === "string" ? entry : null;
}

/**
 * The first element of a destination array: either a page index outright, or a
 * reference to the page object, which only the worker can resolve.
 *
 * Note the asymmetry the format has and we have to keep: a **named**
 * destination's array holds a page *ref*, while an inline one in a linearised
 * document may hold a plain integer index. Both are legal, and treating a ref
 * as an index would silently send every entry to page 1 or 2.
 */
export type DestPageTarget = { kind: "index"; pageIndex: number } | { kind: "ref"; ref: object } | null;

export function destPageTarget(dest: unknown): DestPageTarget {
  if (!Array.isArray(dest) || dest.length === 0) return null;
  const first = dest[0];
  if (typeof first === "number" && Number.isInteger(first) && first >= 0) {
    return { kind: "index", pageIndex: first };
  }
  if (first && typeof first === "object" && "num" in first && "gen" in first) {
    return { kind: "ref", ref: first as object };
  }
  return null;
}

/** A ref's cache key, so sibling entries on one page cost one round trip. */
export function refKey(ref: object): string {
  const { num, gen } = ref as { num: unknown; gen: unknown };
  return `${String(num)}R${String(gen)}`;
}
