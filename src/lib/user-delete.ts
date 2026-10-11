import { prisma } from "@/lib/prisma";
import { revokeTokensOf } from "@/lib/api/tokens";

// Soft-deleting an account, the one body behind /users' Delete
// (src/app/actions/users.ts) and the e2e suite's own account deletion, so the
// spec that holds a deleted account's tokens to refusal exercises exactly
// what the button does.
//
// **One transaction with the account's API tokens** (docs/MCP.md §3): a token
// may be why the account is being deleted, so none outlives it, and restoring
// the account brings none back. The token check refuses a deleted user's
// token anyway, on the filtered user read; revoking as well is what keeps a
// restore from reviving every token the account ever had.
//
// Callers check who may delete whom: plain server code, not "use server".
export async function softDeleteUser(userId: string, deletedByUserId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { deletedByUserId, deletedAt: now } });
    await revokeTokensOf(tx, userId, now);
  });
}
