import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

export const POST_MANAGER_ROLES: Role[] = ["ADMIN", "EDITOR", "AUTHOR"];

export function canManagePosts(role: Role): boolean {
  return POST_MANAGER_ROLES.includes(role);
}

export function canEditAnyPost(role: Role): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

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
