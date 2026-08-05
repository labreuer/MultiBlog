"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";
import { changeUserSlug, revertUserSlug as revertUserSlugInDb } from "@/lib/user-slug";
import { isPageSize } from "@/lib/table-query";
import { normalizeOrcid, normalizeWebsite } from "@/lib/contributor-links";
import { Role, ModerationPolicy } from "@/generated/prisma/enums";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import { generateToken } from "@/lib/tokens";
import { INVITE_TTL_MS } from "@/lib/invite";
import { sendMail } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { SITE_TITLE } from "@/lib/site-config";

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

// The user's default rows-per-page for every admin table (PLAN.md §16b). A
// table's ?pageSize= param overrides this per navigation and never writes
// back here — this is only ever set deliberately, from the Rows/page column.
export async function updateUserRowsPerPage(userId: string, rowsPerPage: number): Promise<void> {
  await requireAdmin();
  if (!isPageSize(rowsPerPage)) {
    throw new Error("Invalid rows per page.");
  }
  await prisma.user.update({ where: { id: userId }, data: { rowsPerPage } });
  revalidatePath("/users");
}

// The only path that sets isListedContributor to true — actions/
// contributor.ts's self-service optOutAsContributor can only clear it
// (PLAN.md §17g/§17h/§17i). Admin can also clear it here, same as any other
// admin-owned field; that's not the asymmetry, the asymmetry is that no
// self-service action can set it.
export async function updateUserIsListedContributor(userId: string, isListedContributor: boolean): Promise<void> {
  await requireAdmin();
  await prisma.user.update({ where: { id: userId }, data: { isListedContributor } });
  revalidatePath("/users");
  revalidatePath("/");
}

// Nullable — clearing it (empty string) sends a contributor to the tail of
// the list rather than tying them at the front (PLAN.md §17e).
export async function updateUserContributorOrder(userId: string, order: number | null): Promise<void> {
  await requireAdmin();
  if (order !== null && !Number.isInteger(order)) {
    throw new Error("Order must be a whole number.");
  }
  await prisma.user.update({ where: { id: userId }, data: { contributorOrder: order } });
  revalidatePath("/users");
  revalidatePath("/");
}

export async function updateUserOrcid(userId: string, orcid: string): Promise<void> {
  await requireAdmin();
  const trimmed = orcid.trim();
  const normalized = trimmed ? normalizeOrcid(trimmed) : null;
  if (trimmed && !normalized) {
    throw new Error("Invalid ORCID iD.");
  }
  await prisma.user.update({ where: { id: userId }, data: { orcid: normalized } });
  revalidatePath("/users");
  revalidatePath("/");
}

export async function updateUserWebsite(userId: string, website: string): Promise<void> {
  await requireAdmin();
  const trimmed = website.trim();
  const normalized = trimmed ? normalizeWebsite(trimmed) : null;
  if (trimmed && !normalized) {
    throw new Error("Website must be a valid http(s) URL.");
  }
  await prisma.user.update({ where: { id: userId }, data: { website: normalized } });
  revalidatePath("/users");
  revalidatePath("/");
}

// Emails userId a link to set a password and claim their (already-created)
// account. Order matters: mint the token, send the mail, and only create the
// UserInvite row once sendMail reports delivered — a row whose sentAt says
// "sent" when delivery failed would be a lie in the audit log this table
// exists to be. Full design: docs/EMAIL.md.
export async function sendUserInvite(userId: string): Promise<{ url: string }> {
  const adminId = await requireAdmin();

  // prisma.user's soft-delete extension already hides a deleted row, so
  // !user covers both "never existed" and "deleted" with one check.
  const [user, admin] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
    // Read fresh rather than trusting the session: the JWT's jwt() callback
    // only ever copies id/role/color at sign-in (src/app/sign-in/NOTES.md),
    // never name/email, so session.user.name isn't reliably populated.
    prisma.user.findUnique({ where: { id: adminId }, select: { email: true, name: true } }),
  ]);
  if (!user) {
    throw new Error("That user no longer exists.");
  }

  // No-cron answer to expiry: sweep this user's own stale, unconsumed tokens
  // whenever they're next invited, rather than a scheduled job. Expired rows
  // for a user never re-invited keep their (unusable) raw token — see
  // docs/EMAIL.md's residual-exposure note.
  await prisma.userInvite.updateMany({
    where: { userId, expiresAt: { lt: new Date() }, token: { not: null } },
    data: { token: null },
  });

  const { raw, hash } = generateToken();
  const url = appUrl(`/invite?token=${raw}`);

  // RESEND_INVITE_TEMPLATE_ID names a Resend Template (docs/EMAIL.md §2)
  // declaring exactly these three variables. Unset falls back to a plain
  // text/subject send — same "absent env var, simplest degraded behavior"
  // shape as RESEND_API_KEY/MAIL_FROM themselves, so this invite still works
  // against a from-scratch deploy with no template ever created.
  const templateId = process.env.RESEND_INVITE_TEMPLATE_ID;
  const invitedByName = admin?.name ?? admin?.email ?? "An admin";

  const result = templateId
    ? await sendMail({
        to: user.email,
        template: {
          id: templateId,
          variables: { invitee: user.name ?? user.email, invited_by: invitedByName, invite_url: url },
        },
      })
    : await sendMail({
        to: user.email,
        subject: `You've been invited to ${SITE_TITLE}`,
        text: `${invitedByName} has invited you to claim your account: ${url}\n\nThis link expires in 14 days.`,
      });
  if (!result.delivered) {
    throw new Error(`Couldn't send the invite: ${result.error ?? "unknown error"}`);
  }

  await prisma.userInvite.create({
    data: {
      userId,
      invitedById: adminId,
      token: raw,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  revalidatePath("/users");
  return { url };
}

export async function updateUserSlug(userId: string, newSlug: string): Promise<{ slug: string }> {
  await requireAdmin();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { slug: true } });
  if (!user) {
    throw new Error("User not found.");
  }
  const slug = await changeUserSlug(userId, newSlug);

  revalidatePath("/users");
  revalidatePath(`/users/${userId}/slug`);
  revalidatePath(`/authors/${user.slug}`);
  revalidatePath(`/authors/${slug}`);
  return { slug };
}

// Deleted by its slug value (globally unique) rather than a history row id —
// scoped to userId too so a delete call can't remove another user's entry
// even by guessing/reusing a slug string.
export async function deleteUserSlugHistory(userId: string, slug: string): Promise<void> {
  await requireAdmin();
  await prisma.userSlugHistory.deleteMany({ where: { userId, slug } });
  revalidatePath(`/users/${userId}/slug`);
}

export async function revertUserSlug(userId: string): Promise<{ slug: string }> {
  await requireAdmin();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { slug: true } });
  if (!user) {
    throw new Error("User not found.");
  }
  const oldSlug = user.slug;
  const slug = await revertUserSlugInDb(userId);

  revalidatePath("/users");
  revalidatePath(`/users/${userId}/slug`);
  revalidatePath(`/authors/${oldSlug}`);
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

// Bulk actions (PLAN.md §16g). Each delegates to the single-row action, so
// every row goes through the same requireAdmin and the same guards — notably
// deleteUser's "you can't delete your own account" and updateUserRole's "you
// can't remove your own admin role", which a bulk path must not be able to
// sidestep.
export async function bulkDeleteUsers(userIds: string[]): Promise<BulkResult> {
  return settleBulk(userIds, (id) => deleteUser(id));
}

export async function bulkRestoreUsers(userIds: string[]): Promise<BulkResult> {
  return settleBulk(userIds, (id) => restoreUser(id));
}

export async function bulkSetUserRole(userIds: string[], role: Role): Promise<BulkResult> {
  return settleBulk(userIds, (id) => updateUserRole(id, role));
}

export async function bulkSetUserModerationPolicy(userIds: string[], policy: ModerationPolicy): Promise<BulkResult> {
  return settleBulk(userIds, (id) => updateUserModerationPolicy(id, policy));
}
