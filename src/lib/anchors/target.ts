import { ANCHOR_TARGET_KINDS, type AnchorTarget, type AnchorTargetKind } from "./types";

// PLAN.md §20a — the one place the object arc's four nullable FK columns are
// turned into `AnchorTarget` and back.
//
// Both anchor tables use these rather than reading the columns directly, which
// is what keeps "exactly one non-null" from being restated per call site. The
// database enforces it with a hand-written `CHECK (num_nonnulls(…) = 1)`; this
// is the application-side face of the same rule, and `targetFromColumns`
// returning null is what a row violating it would look like from here — a
// state the CHECK makes unreachable, handled anyway rather than asserted away.

/** The column shape shared by `tag_anchor` (and, in PR 2, `annotation_anchor`). */
export type AnchorTargetColumns = {
  docId: string | null;
  postId: string | null;
  fileId: string | null;
  targetAnnotationId: string | null;
};

/** `AnchorTarget` → the four columns, exactly one of them set. */
export function targetToColumns(target: AnchorTarget): AnchorTargetColumns {
  return {
    docId: target.kind === "doc" ? target.id : null,
    postId: target.kind === "post" ? target.id : null,
    fileId: target.kind === "file" ? target.id : null,
    targetAnnotationId: target.kind === "annotation" ? target.id : null,
  };
}

/**
 * The four columns → `AnchorTarget`, or null if the arc is malformed (none
 * set, or more than one). Unreachable while the CHECK holds; denying is the
 * safe answer if it ever doesn't, the same stance
 * `canUserAccessAnnotationYdoc` takes on a container-less annotation.
 */
export function targetFromColumns(columns: AnchorTargetColumns): AnchorTarget | null {
  const set: AnchorTarget[] = [];
  if (columns.docId !== null) set.push({ kind: "doc", id: columns.docId });
  if (columns.postId !== null) set.push({ kind: "post", id: columns.postId });
  if (columns.fileId !== null) set.push({ kind: "file", id: columns.fileId });
  if (columns.targetAnnotationId !== null) set.push({ kind: "annotation", id: columns.targetAnnotationId });
  return set.length === 1 ? set[0] : null;
}

/**
 * Narrows an untrusted string (a server-action argument, a querystring value)
 * to a target kind. Same stance `parseSelector` takes on a jsonb blob: nothing
 * a client names reaches a column without passing through a parse.
 */
export function parseAnchorTargetKind(value: unknown): AnchorTargetKind | null {
  return typeof value === "string" && (ANCHOR_TARGET_KINDS as readonly string[]).includes(value)
    ? (value as AnchorTargetKind)
    : null;
}

/** A stable key for "the same object", for deduping anchors across an assignment. */
export function targetKey(target: AnchorTarget): string {
  return `${target.kind}:${target.id}`;
}
