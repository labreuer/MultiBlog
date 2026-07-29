// Splits overlapping ranges into the minimal set of non-overlapping segments,
// each tagged with every range that covers it. Needed because when two
// Decoration.inline ranges overlap, ProseMirror doesn't reliably preserve
// both decorations' custom (data-*) attributes on the shared span for the
// overlapping portion — one silently wins and the other's attribute is
// dropped, which made a fully-nested quote (e.g. "kind" inside "kind of")
// vanish from the DOM entirely. Building non-overlapping segments up front
// sidesteps that instead of relying on ProseMirror's merge. This is a
// property of ProseMirror itself, not of any one caller — originally lived
// only in quote-highlight-extension.ts; extracted here so doc-link-extension
// (PLAN.md §14e) can share it rather than risk the two drifting.
export type SegmentInput = {
  id: string;
  from: number;
  to: number;
  color: string | null;
};

export type Segment<T extends SegmentInput> = {
  from: number;
  to: number;
  ids: string[];
  color: string | null;
  sources: T[];
};

export function buildSegments<T extends SegmentInput>(ranges: T[], docSize: number): Segment<T>[] {
  const clamped = ranges
    .map((r) => ({
      ...r,
      from: Math.max(0, Math.min(r.from, docSize)),
      to: Math.max(0, Math.min(r.to, docSize)),
    }))
    .filter((r) => r.to > r.from);

  const boundaries = Array.from(new Set(clamped.flatMap((r) => [r.from, r.to]))).sort((a, b) => a - b);

  const segments: Segment<T>[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    const covering = clamped.filter((r) => r.from <= from && r.to >= to);
    if (covering.length > 0) {
      // A segment shared by ranges with different colors has no single color
      // to show — callers fall back to a neutral gray rather than picking
      // one arbitrarily.
      const colors = new Set(covering.map((r) => r.color));
      segments.push({
        from,
        to,
        ids: covering.map((r) => r.id),
        color: colors.size === 1 ? covering[0].color : null,
        sources: covering,
      });
    }
  }
  return segments;
}
