"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";
import { changeUserSlug } from "@/lib/user-slug";
import { Role, ModerationPolicy } from "@/generated/prisma/enums";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function requireAdmin(): Promise<string> {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) {
    throw new Error("You don't have permission to manage users.");
  }
  return session.user.id;
}

export async function updateUserRole(userId: string, role: Role): Promise<void> {
  const adminId = await requireAdmin();
  if (!Object.values(Role).includes(role)) {
    throw new Error("Invalid role.");
  }
  if (adminId === userId && role !== Role.ADMIN) {
    throw new Error("You can't remove your own admin role.");
  }
  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath("/users");
}

export async function updateUserModerationPolicy(userId: string, moderationPolicy: ModerationPolicy): Promise<void> {
  await requireAdmin();
  if (!Object.values(ModerationPolicy).includes(moderationPolicy)) {
    throw new Error("Invalid moderation policy.");
  }
  await prisma.user.update({ where: { id: userId }, data: { moderationPolicy } });
  revalidatePath("/users");
}

export async function updateUserColor(userId: string, color: string): Promise<void> {
  await requireAdmin();
  if (!HEX_COLOR_RE.test(color)) {
    throw new Error("Invalid color.");
  }
  await prisma.user.update({ where: { id: userId }, data: { color } });
  revalidatePath("/users");
}

export async function updateUserName(userId: string, name: string): Promise<void> {
  await requireAdmin();
  await prisma.user.update({ where: { id: userId }, data: { name: name.trim() || null } });
  revalidatePath("/users");
}

export async function updateUserAdminInitials(userId: string, adminInitials: string): Promise<void> {
  await requireAdmin();
  const trimmed = adminInitials.trim();
  if (!trimmed) {
    throw new Error("Initials can't be empty.");
  }
  await prisma.user.update({ where: { id: userId }, data: { adminInitials: trimmed } });
  revalidatePath("/users");
}

export async function updateUserSlug(userId: string, newSlug: string): Promise<{ slug: string }> {
  await requireAdmin();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { slug: true } });
  if (!user) {
    throw new Error("User not found.");
  }
  const slug = await changeUserSlug(userId, newSlug);

  revalidatePath("/users");
  revalidatePath(`/authors/${user.slug}`);
  revalidatePath(`/authors/${slug}`);
  return { slug };
}

// Soft delete/restore double as each other's undo — no confirmation dialog;
// the row stays visible with the icon swapped, so a mis-click is one more
// click to reverse instead of a modal to dismiss.
export async function deleteUser(userId: string): Promise<void> {
  const adminId = await requireAdmin();
  if (adminId === userId) {
    throw new Error("You can't delete your own account.");
  }
  await prisma.user.update({ where: { id: userId }, data: { deletedByUserId: adminId, deletedAt: new Date() } });
  revalidatePath("/users");
}

export async function restoreUser(userId: string): Promise<void> {
  await requireAdmin();
  await prisma.user.update({ where: { id: userId }, data: { deletedByUserId: null, deletedAt: null } });
  revalidatePath("/users");
}
