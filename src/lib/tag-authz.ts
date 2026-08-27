import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canApplyTags, canCurateTags } from "@/lib/role-checks";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { publishedPostWhere } from "@/lib/post-status";
import type { AnchorTarget } from "@/lib/anchors";

export { canApplyTags, canCurateTags } from "@/lib/role-checks";

// PLAN.md §20d — who may tag what, and who may curate the vocabulary.
// docs/PERMISSIONS.md carries the same rules as tables and is the map; this
// file is the territory.
//
// **The rule is "you may tag what you may read", plus a role floor.** The role
// floor (canApplyTags, ADMIN/EDITOR/AUTHOR/AUTHORIZED) is what keeps
// tagging away from COMMENTER and signed-out visitors; the per-object gate
// below is each target kind's own existing read predicate, reused rather than
// restated. Reusing them is the whole point: a tag chip on a PRIVATE doc
// is exactly as private as the doc, without a second place where that could be
// got wrong.
//
// **Posts are where the role floor does the work.** Reading a published post
// is open to everyone including signed-out readers, and the analogous act of
// *commenting* on one is open to COMMENTER — so "follows the permission to
// annotate that surface" read literally would let anonymous visitors grow the
// site's vocabulary. That is not what §20d means by it. A tag is curatorial
// where a comment is conversational: it changes what a term denotes and what
// /tag/[slug] lists, for everyone. So the three surfaces are consistent
// here, and all three require a signed-in AUTHORIZED-or-better account.
//
// Recorded as a judgment call rather than a reading of §20d, because §20d's
// wording admits the looser interpretation and this deliberately doesn't take
// it.

/**
 * Whether `userId` may attach or detach their own tag on `target`.
 *
 * One query per call and no caching: every caller has already loaded the
 * object it is asking about, but through four different shapes, and taking the
 * id keeps this callable from a server action that has only that.
 */
export async function canUserTagTarget(userId: string, role: Role, target: AnchorTarget): Promise<boolean> {
  if (!canApplyTags(role)) return false;

  switch (target.kind) {
    case "doc": {
      const doc = await prisma.doc.findUnique({
        where: { id: target.id },
        select: { id: true, visibility: true },
      });
      // `prisma` (not prismaIncludingDeleted) — a soft-deleted doc reads as
      // absent here, which is the answer we want: you cannot tag something in
      // the trash.
      return doc !== null && (await canUserReadDoc(userId, role, doc));
    }
    case "file": {
      const file = await prisma.storedFile.findUnique({
        where: { id: target.id },
        select: { id: true, visibility: true },
      });
      return file !== null && (await canUserReadFile(userId, role, file));
    }
    case "post": {
      // publishedPostWhere rather than a bare existence check, for the reason
      // it exists at all: a scheduled post already carries publishEventId, so
      // checking that alone would let a tag land on something not yet live —
      // and /tag/[slug] would then be the surface that leaked it.
      const post = await prisma.post.findFirst({
        where: { id: target.id, ...publishedPostWhere() },
        select: { id: true },
      });
      return post !== null;
    }
    case "annotation": {
      // An annotation's readability is its *container's*, with DRAFT as the
      // one exception: "keep private" means private even from ADMIN, so a
      // DRAFT is owner-only with no override (src/lib/annotation-authz.ts,
      // PLAN.md §13d). Restated rather than delegated to
      // canUserAccessAnnotationYdoc, which answers a different question —
      // "may you open a writable connection to its body" — and would drag the
      // wrong default here if that one ever loosened.
      const annotation = await prisma.annotation.findFirst({
        where: { id: target.id, deletedAt: null },
        select: {
          userId: true,
          status: true,
          doc: { select: { id: true, visibility: true } },
          file: { select: { id: true, visibility: true } },
        },
      });
      if (!annotation) return false;
      if (annotation.status === "DRAFT") return annotation.userId === userId;
      if (annotation.doc) return canUserReadDoc(userId, role, annotation.doc);
      if (annotation.file) return canUserReadFile(userId, role, annotation.file);
      // Neither container. Unreachable while annotation_one_container_check
      // holds; denying is the safe answer if it ever doesn't.
      return false;
    }
  }
}

/**
 * Whether `userId` may remove an assignment — **their own tag, or anyone's if
 * they curate.**
 *
 * Deliberately not "whoever may tag the object may untag it": an act of tagging
 * is attributable (`tag_assignment.user_id`), and letting any AUTHORIZED
 * reader retract someone else's reading of a document is a moderation power,
 * not a tagging one. Same shape as `requireOwnOrAdmin` for annotations
 * (src/app/actions/annotations.ts), widened to EDITOR because curating shared
 * vocabulary is exactly what an EDITOR is for.
 */
export function canUserRemoveAssignment(userId: string, role: Role, assignmentUserId: string): boolean {
  return assignmentUserId === userId || canCurateTags(role);
}
