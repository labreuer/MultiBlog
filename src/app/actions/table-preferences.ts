"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { AdminTableName } from "@/lib/user-preferences";

// "Save as my default" from an admin table's column picker (PLAN.md §16i).
//
// The first *self-service* preference action in the app, and deliberately so:
// every other write in src/app/actions/users.ts is an admin acting on someone
// else's row and carries the matching authorization guard. This one only ever
// touches the caller's own row — the id comes from the session, never from an
// argument — so there is no target to authorize against and no way to aim it
// at another user. Being signed in is the whole check.
//
// (§16l wants a /dashboard surface for editing rowsPerPage the same way, since
// that one is currently reachable only through the ADMIN-only /users. This
// action is the shape that should take.)
export async function saveTableColumns(table: AdminTableName, cols: string[]): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }

  // Read-modify-write rather than a jsonb path update: the column holds one
  // small object per user, the other tables' keys have to survive, and Prisma
  // has no typed partial-update for a Json field. Two statements, no
  // transaction — a concurrent save from the same user in another tab would be
  // last-write-wins over *their own* preference, which is what they would
  // expect anyway.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { columnOrder: true },
  });
  if (!user) {
    // The JWT outlives the row (see getTablePrefs) — say so rather than
    // writing a preference for a user that no longer exists.
    throw new Error("Your account no longer exists.");
  }

  const existing =
    user.columnOrder !== null && typeof user.columnOrder === "object" && !Array.isArray(user.columnOrder)
      ? (user.columnOrder as Prisma.InputJsonObject)
      : {};

  await prisma.user.update({
    where: { id: session.user.id },
    data: { columnOrder: { ...existing, [table]: cols } satisfies Prisma.InputJsonObject },
  });

  // The preference is read server-side on the next render of that table, so
  // the page has to be re-rendered for a save to take effect without the
  // ?cols= override that is currently carrying it.
  revalidatePath(`/${table}`);
}
