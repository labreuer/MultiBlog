// An annotation's permalink fragment on its doc or PDF page — `#<name>-<timestamp>`,
// the id AnnotationNode gives the card. Pure and browser-safe, here rather
// than inside AnnotationNode so a server-side link (search's hits,
// docs/FULLTEXT.md §7) can point at an annotation with the same fragment the
// page renders, and the two cannot drift. comment-anchor-name.ts is the
// comment side, for the same reason.
//
// Down to the second is enough that a collision would mean the same person
// annotated twice in the same second, which shouldn't happen; not worth guarding.
export function annotationAnchorName(displayName: string, createdAt: string | Date): string {
  const name = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const timestamp = new Date(createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${name || "annotation"}-${timestamp}`;
}
