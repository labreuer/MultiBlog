import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/role-checks";
import { removeAnnotationMark } from "@/lib/annotation-admin";
import { ApiError, forbidden } from "@/lib/api/errors";
import type { Actor } from "@/lib/actor";

/**
 * Soft-deletes or restores an annotation, as its writer or an ADMIN — and a
 * DRAFT as its writer alone: a DRAFT is its owner's alone, and an ADMIN's
 * role reaches no further into one here than it does when reading
 * (docs/MCP.md §17, item 4). The actions behind the margin and /annotations
 * (src/app/actions/annotations.ts) wrap it with the session, and the MCP
 * server's `manage` with a token's user; callers revalidate.
 *
 * Deleting a posted doc annotation also takes its mark out of the doc, when
 * it has one. A DRAFT never had one applied (§13d), and a *file* annotation
 * never has one either, since a file has no ydoc (PLAN.md §19).
 */
export async function setAnnotationDeleted(
  actor: Actor,
  annotationId: string,
  deleted: boolean,
): Promise<{ docId: string | null; fileId: string | null }> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { userId: true, docId: true, fileId: true, status: true },
  });
  if (!annotation) throw new ApiError("not_found", "Annotation not found.");
  const isOwn = annotation.userId === actor.userId;
  if (!isOwn && (annotation.status === "DRAFT" || !isAdmin(actor.role))) {
    throw forbidden("You don't have permission to modify this annotation.");
  }
  await prisma.annotation.update({
    where: { id: annotationId },
    data: deleted ? { deletedByUserId: actor.userId, deletedAt: new Date() } : { deletedByUserId: null, deletedAt: null },
  });
  if (deleted && annotation.status !== "DRAFT" && annotation.docId !== null) {
    await removeAnnotationMark({ docId: annotation.docId, userId: actor.userId, role: actor.role, annotationId });
  }
  return { docId: annotation.docId, fileId: annotation.fileId };
}
