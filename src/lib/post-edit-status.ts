import type { Role } from "@/generated/prisma/enums";
import { canEditAnyPost } from "@/lib/authz";

type PostForEditStatus = {
  authors: { userId: string }[];
  revisions: { createdAt: Date }[];
  collab: { updatedAt: Date } | null;
};

export type PostEditStatus = { canEdit: boolean; hasPendingEdits: boolean };

const NO_ACCESS: PostEditStatus = { canEdit: false, hasPendingEdits: false };

// Cheap stand-in for diffing the live Yjs doc against the last saved
// revision (see PERFORMANCE.md's O(n·m) note on `diffText`): a collab
// snapshot stored *after* the latest revision was saved means something
// changed since — PostCollab.ydoc is never deleted on save, so its mere
// existence doesn't imply pending edits, only that this timestamp
// comparison does.
export function getPostEditStatus(
  user: { id: string; role: Role } | undefined | null,
  post: PostForEditStatus,
): PostEditStatus {
  if (!user) {
    return NO_ACCESS;
  }
  const canEdit = canEditAnyPost(user.role) || (user.role === "AUTHOR" && post.authors.some((a) => a.userId === user.id));
  if (!canEdit) {
    return NO_ACCESS;
  }

  const latestRevisionAt = post.revisions[0]?.createdAt;
  const collabAt = post.collab?.updatedAt;
  const hasPendingEdits = !!collabAt && !!latestRevisionAt && collabAt.getTime() > latestRevisionAt.getTime();
  return { canEdit: true, hasPendingEdits };
}
