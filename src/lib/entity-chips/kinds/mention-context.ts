import { prismaIncludingDeleted } from "../../prisma";
import type { MentionContext } from "./mention";

// docs/MENTIONS.md, "Context" — each mentioned user's name, initials and
// slug. Server-only: the browser gets the same shape from the chip-context
// endpoint.

/**
 * The mention context for these user ids. An id with no row is left out, and
 * renders as an unknown person.
 *
 * Deleted users are read, through `prismaIncludingDeleted`, because the
 * default client hides them: a deleted account's mention keeps its label,
 * struck through, and restoring the account clears that.
 *
 * No email is selected, so no label can fall back to one.
 */
export async function loadMentionContext(userIds: readonly string[]): Promise<MentionContext> {
  if (userIds.length === 0) return {};
  const users = await prismaIncludingDeleted.user.findMany({
    where: { id: { in: [...userIds] } },
    select: {
      id: true,
      name: true,
      adminInitials: true,
      slug: true,
      deletedAt: true,
      worksFor: { select: { name: true, slug: true } },
    },
  });
  const context: MentionContext = {};
  for (const user of users) {
    context[user.id] = {
      id: user.id,
      name: user.name,
      initials: user.adminInitials,
      slug: user.slug,
      deleted: user.deletedAt !== null,
      // A bot's person by name, or by handle when they have none.
      botOf: user.worksFor ? user.worksFor.name?.trim() || user.worksFor.slug : null,
    };
  }
  return context;
}
