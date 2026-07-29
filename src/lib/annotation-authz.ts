import type { Role } from "@/generated/prisma/enums";
import type { AnnotationStatus } from "@/generated/prisma/enums";
import { canUserReadDoc } from "./doc-authz";

// PLAN.md §13a/§13d — who may open a writable connection to an annotation's
// own ydoc. Deliberately one gate, not the writable/readOnly split
// doc-authz.ts's canUserReadDoc/canUserEditDoc pair has for a doc body: a
// doc's body is editable only by its byline AUTHORs, but an annotation has
// no such narrower group — anyone who could already post a *reply* under it
// (canUserReadDoc) is exactly who should be able to help write its live
// text too. DRAFT is the one exception: "keep private" means private even
// from ADMIN, so it's owner-only with no override, not merely narrower.
export async function canUserAccessAnnotationYdoc(
  userId: string,
  role: Role,
  annotation: { userId: string; status: AnnotationStatus; doc: { id: string; visibility: "PRIVATE" | "SHARED" } },
): Promise<boolean> {
  if (annotation.status === "DRAFT") {
    return annotation.userId === userId;
  }
  return canUserReadDoc(userId, role, annotation.doc);
}
