// PLAN.md §20a/§20b — the anchor **envelope**, shared by every consumer family
// that has to say "this row names one target — an object, and optionally a
// part of it."
//
// **What is shared here is the envelope, not the selector.** COLLAB.md's
// conclusion stands: the selector mechanism follows the target's mutability
// and the writer's rights, and there is no universal anchor. The doc editor's
// mark stays a mark (§12i/§13o), a reading-view range stays offsets-plus-stamp
// (§13o), a PDF anchor stays a measured-once blob (§19). What generalizes is
// only the shape of the row.
//
// The compiler is what holds the two anchor tables (`keyword_anchor`,
// and `annotation_anchor` in PR 2) to one column shape — the precedent is the
// four slug-history tables, which share a shape by convention and nothing
// else. Here the shape is also this file plus the capture/resolve pair beside
// it, so a divergence is a type error rather than something review has to
// catch.

/** A resolved position in a ProseMirror document. */
export type AnchorRange = { from: number; to: number };

// The object arc, as a discriminated union — the TypeScript face of
// `keyword_anchor`'s four nullable FKs (`doc_id`, `post_id`, `file_id`,
// `target_annotation_id`), exactly one of which is non-null under a
// hand-written `CHECK (num_nonnulls(…) = 1)`.
//
// Real FKs rather than a `(type, id)` pair because this schema leans hard on
// cascades: deleting a doc must take every anchor pointing at it (§20a). The
// cost, accepted with eyes open, is that **a new targetable kind is a
// migration** — one column, one index, one CHECK edit, per anchor table. This
// union is the other half of that cost, and deliberately so: adding a member
// here makes every `switch` over it fail to compile until it is handled.
export type AnchorTarget =
  | { kind: "doc"; id: string }
  | { kind: "post"; id: string }
  | { kind: "file"; id: string }
  | { kind: "annotation"; id: string };

export type AnchorTargetKind = AnchorTarget["kind"];

export const ANCHOR_TARGET_KINDS: readonly AnchorTargetKind[] = ["doc", "post", "file", "annotation"];

// The part selector's kind — `null` on a row means the anchor names the
// *whole* object, which is the only thing PR 1 writes (§20h). Mirrors the
// `SelectorKind` enum in the schema; `POST_RANGE` is deliberately absent from
// both until its writer exists (§20i), since `ALTER TYPE … ADD VALUE` is cheap
// and an enum value with no writer is not.
export type SelectorKind = "DOC_RANGE" | "PDF_TEXT";

export const SELECTOR_KINDS: readonly SelectorKind[] = ["DOC_RANGE", "PDF_TEXT"];
