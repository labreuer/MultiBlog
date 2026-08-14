// PLAN.md §19 — what an annotation is *about*: a doc, or an uploaded file.
//
// `Annotation` carries a nullable `docId` and a nullable `fileId`, with a
// database CHECK guaranteeing exactly one is set (schema.prisma). That
// guarantee is invisible to TypeScript, which sees two independently-nullable
// columns, so every consumer would otherwise either re-derive the invariant or
// quietly `!`-assert it. This module is the one place that turns the pair into
// a value the compiler can reason about.

export type AnnotationContainer = { kind: "doc"; docId: string } | { kind: "file"; fileId: string };

export type AnnotationContainerColumns = { docId: string | null; fileId: string | null };

/**
 * The discriminated form of the (docId, fileId) pair.
 *
 * Throws only if the CHECK constraint has been violated, which no code path
 * can do — the throw is here so that a future migration that loosens the
 * constraint fails loudly at the first read rather than producing an
 * annotation attached to nothing.
 */
export function annotationContainer(row: AnnotationContainerColumns): AnnotationContainer {
  if (row.docId !== null) return { kind: "doc", docId: row.docId };
  if (row.fileId !== null) return { kind: "file", fileId: row.fileId };
  throw new Error("Annotation has neither a doc nor a file — annotation_one_container_check should prevent this.");
}

/**
 * Narrows to the doc case for a code path that **has not grown its file branch
 * yet** (PLAN.md §19, Phase 3).
 *
 * Deliberately a named function rather than a `!` or a cast at each site, for
 * two reasons. It is greppable: `requireDocAnnotationId` is exactly the list of
 * places Phase 3 has to visit, and that list cannot go stale the way a comment
 * would. And it fails as a clear, attributable error rather than as
 * `ydoc:null`, which is what a non-null assertion would have produced —
 * silently, several layers downstream, in a document name.
 *
 * Nothing can reach it today: no surface creates a file annotation until the
 * PDF composer exists. That is the point — the guard states the assumption the
 * doc-only paths have always made, now that the schema no longer states it for
 * them.
 */
export function requireDocAnnotationId(row: AnnotationContainerColumns, context: string): string {
  const container = annotationContainer(row);
  if (container.kind === "file") {
    throw new Error(`${context} doesn't handle file annotations yet (PLAN.md §19, Phase 3).`);
  }
  return container.docId;
}

/**
 * Paths to revalidate after an annotation is created, posted, deleted or
 * restored — for the actions that are genuinely container-agnostic (delete and
 * restore are `requireOwnOrAdmin` and never consult the container at all, per
 * docs/PERMISSIONS.md), so they get a real branch here rather than the guard
 * above.
 *
 * The doc branch reproduces what the doc-side actions have always passed,
 * including its oddity: `/doc/<id>` where the route is `/doc/<slug>`. Mirrored
 * rather than corrected, because changing it is a doc-side revalidation
 * question with its own consequences and nothing to do with files.
 *
 * The file branch names `/files` instead of the file's own page, and that is
 * the right target rather than a fallback: `/files` renders
 * `file_metrics.annotation_count`, which is exactly the value that just
 * changed. The viewer itself gets its updates over the wire (PLAN.md §19,
 * Phase 4), not from a revalidation.
 */
export function annotationRevalidationPaths(row: AnnotationContainerColumns): string[] {
  const container = annotationContainer(row);
  return container.kind === "doc" ? [`/doc/${container.docId}`] : ["/files"];
}
