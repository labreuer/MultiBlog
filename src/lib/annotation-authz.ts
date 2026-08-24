import type { Role } from "@/generated/prisma/enums";
import type { AnnotationStatus } from "@/generated/prisma/enums";
import { canUserReadDoc } from "./doc-authz";
import { canUserReadFile } from "./file-authz";

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
