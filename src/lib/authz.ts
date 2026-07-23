import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/role-checks";

export { POST_MANAGER_ROLES, canManagePosts, canEditAnyPost, isAdmin } from "@/lib/role-checks";

export async function canUserEditPost(userId: string, role: Role, postId: string): Promise<boolean> {
  if (canEditAnyPost(role)) {
    return true;
  }
  if (role !== "AUTHOR") {
    return false;
  }
  const author = await prisma.postAuthor.findUnique({
    where: { postId_userId: { postId, userId } },
  });
  return !!author;
}
