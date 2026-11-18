"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/role-checks";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

// /email-collisions' one write (docs/COMMENTS.md, "The log"): marking a row
// reviewed, one at a time or in bulk. ADMIN-only, as the page is, since the
// table holds emails and IP addresses.
//
// **There is no "unreview".** A reviewed row leaves the fold's partial unique
// index, so the next meeting on that email starts a new unreviewed row;
// putting the old one back could collide with it. A merge of the two
// identities, if one is wanted, is done by hand (TODO.md).

async function requireAdmin(): Promise<string> {
  const session = await auth();
  if (!session?.user || !isAdmin(session.user.role)) {
    throw new Error("Only an ADMIN may review email collisions.");
  }
  return session.user.id;
}

async function markReviewed(reviewerId: string, id: string): Promise<void> {
  // updateMany with the null in the where, so marking a row twice keeps its
  // first reviewer and time rather than overwriting them.
  await prisma.emailCollision.updateMany({
    where: { id, reviewedAt: null },
    data: { reviewedAt: new Date(), reviewedById: reviewerId },
  });
}

export async function markEmailCollisionReviewed(id: string): Promise<void> {
  const reviewerId = await requireAdmin();
  await markReviewed(reviewerId, id);
  revalidatePath("/email-collisions");
  revalidatePath("/dashboard");
}

export async function bulkMarkEmailCollisionsReviewed(ids: string[]): Promise<BulkResult> {
  const reviewerId = await requireAdmin();
  const { failed } = await settleBulk(ids, (id) => markReviewed(reviewerId, id));
  revalidatePath("/email-collisions");
  revalidatePath("/dashboard");
  return { failed };
}
