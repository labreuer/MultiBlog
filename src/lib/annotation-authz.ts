import type { Role } from "@/generated/prisma/enums";
import type { AnnotationStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { isAdmin } from "./role-checks";
import { canUserReadDoc, readableDocsWhere } from "./doc-authz";
import { canUserReadFile, readableFilesWhere } from "./file-authz";

type Container = { id: string; visibility: "PRIVATE" | "SHARED" };

// PLAN.md §13a/§13d — who may open a writable connection to an annotation's
// own ydoc. Deliberately one gate, not the writable/readOnly split
// doc-authz.ts's canUserReadDoc/canUserEditDoc pair has for a doc body: a
// doc's body is editable only by its byline AUTHORs, but an annotation has
// no such narrower group — anyone who could already post a *reply* under it
// (canUserReadDoc) is exactly who should be able to help write its live
// text too. DRAFT is the one exception: "keep private" means private even
// from ADMIN, so it's owner-only with no override, not merely narrower.
//
// PLAN.md §19 — an annotation hangs off a doc *or* a file, so the non-DRAFT
// branch asks whichever container it actually has. The rule itself doesn't
// change shape: "may read the thing this is about" is still the whole test,
// and canUserReadFile is deliberately a separate function from canUserReadDoc
// rather than a delegation (see file-authz.ts), so this has to name both.
export async function canUserAccessAnnotationYdoc(
  userId: string,
  role: Role,
  annotation: {
    userId: string;
    status: AnnotationStatus;
    doc: Container | null;
    file: Container | null;
  },
): Promise<boolean> {
  if (annotation.status === "DRAFT") {
    return annotation.userId === userId;
  }
  if (annotation.doc) {
    return canUserReadDoc(userId, role, annotation.doc);
  }
  if (annotation.file) {
    return canUserReadFile(userId, role, annotation.file);
  }
  // Neither container present. Unreachable while annotation_one_container_check
  // holds; denying is the safe answer if it ever doesn't.
  return false;
}

/**
 * Not a DRAFT (PLAN.md §13d). Every listing of annotations wears this — the
 * doc and PDF thread loaders, `/annotations`, search — because a DRAFT is a
 * private note that no list shows, its own writer's included; the one place a
 * writer finds their drafts again is a separate, narrower query scoped to
 * their own id (`getOwnDraftAnnotations`).
 */
export function postedAnnotationWhere(): Prisma.AnnotationWhereInput {
  return { status: { not: "DRAFT" } };
}

/**
 * canUserAccessAnnotationYdoc above as a `where` on Annotation, for this
 * viewer: posted, and on a doc or PDF this viewer may read, each container
 * asked by its own rule. Prisma can't share a boolean predicate between a
 * per-row check and a query filter, so proximity plus this comment is what
 * keeps the two honest.
 *
 * Two differences from the per-row check, both deliberate:
 *
 * - **No DRAFT arm.** That function admits a DRAFT's own writer, because the
 *   writer is who composes it; a listing shows nobody's drafts.
 * - **Deletion is the caller's.** A deleted annotation is still readable —
 *   a thread renders "[deleted]" in place of one that has live replies — so
 *   whether to list it is a property of the surface, not the rule.
 *
 * `includeDeletedContainers` lets annotations on a soft-deleted doc or PDF
 * through. Only `/annotations` passes it; see there.
 *
 * Null means this viewer can read no doc and no PDF, so no annotation either.
 * A relation filter never matches a null foreign key, so the doc arm excludes
 * every PDF annotation and vice versa, and the two together are exactly
 * "annotations on something this viewer may read".
 */
export function readableAnnotationsWhere(
  userId: string,
  role: Role,
  opts: { includeDeletedContainers?: boolean } = {},
): Prisma.AnnotationWhereInput | null {
  const containerOpts = { includeDeleted: opts.includeDeletedContainers };
  const docs = readableDocsWhere(userId, role, containerOpts);
  const files = readableFilesWhere(userId, role, containerOpts);
  const containers: Prisma.AnnotationWhereInput[] = [];
  if (docs) containers.push({ doc: docs });
  if (files) containers.push({ file: files });
  if (containers.length === 0) return null;
  return { AND: [postedAnnotationWhere(), { OR: containers }] };
}

// PLAN.md §22e/§22f — who may *write* a posted annotation's body, as opposed
// to who may open a connection to it at all (above). Author or ADMIN — the
// same `requireOwnOrAdmin` pair that already gates deleting one, deliberately
// rather than a new predicate: whoever may remove an annotation outright is
// exactly who may reword it, and an EDITOR who can merely read the container
// can do neither.
//
// **This is the gate the function above deliberately did not have**, and the
// comment above is still true of what it answers: it collapses "may read" and
// "may connect" into one question. What it never answered is "may edit", and
// until §22e nothing asked — no UI opened a writable connection to a posted
// body, so the writable token every reader was handed went unused
// (docs/COLLAB.md's 2026-08-13 entry called this the real gate on mutable
// bodies). `/api/annotation/[id]/token` now asks both: this one decides
// `readOnly`, that one decides 401/403.
//
// Pure and synchronous, unlike its sibling — neither branch needs the
// container, which is why a DRAFT needs no special case here. A DRAFT is
// owner-only by the connection gate, and its owner passes this one too.
export function canUserEditAnnotationBody(
  userId: string,
  role: Role,
  annotation: { userId: string },
): boolean {
  return annotation.userId === userId || isAdmin(role);
}
