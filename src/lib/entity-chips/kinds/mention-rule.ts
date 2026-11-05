import type { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { prisma } from "@/lib/prisma";
import { canInsertMentions, MENTION_ROLES } from "./mention";

// docs/MENTIONS.md, "Who is listed" — the one rule for who a viewer may
// mention. It binds the mention menu, MCP's lookup, the merge's
// `unknown_chip` check, and the people the chip-context endpoint answers for
// beyond an object's own chips, so a slug typed into Markdown can't get round
// what the menu offers. Server-only.

/**
 * The accounts `actor` may mention in the doc `docId` (null: an object with
 * no doc behind it, such as a note on a PDF), as a `where` on User. Null when
 * the actor may mention nobody.
 *
 * - Every named ADMIN, EDITOR and AUTHOR who isn't a bot.
 * - The actor's own bots. For a bot, "own" means its person's, so an agent
 *   can mention itself and its person's other bots.
 * - Another person's bot only when it already takes part in this doc: it is
 *   on the doc's byline, or it wrote a note on it.
 *
 * Soft-deleted accounts are excluded by the default client, which every
 * caller uses.
 */
export async function mentionableUsersWhere(actor: Actor, docId: string | null): Promise<Prisma.UserWhereInput | null> {
  if (!canInsertMentions(actor.role)) return null;

  const self = await prisma.user.findUnique({ where: { id: actor.userId }, select: { worksForUserId: true } });
  const person = self?.worksForUserId ?? actor.userId;

  const named: Prisma.UserWhereInput = { name: { not: null }, NOT: { name: "" } };
  return {
    AND: [
      named,
      {
        OR: [
          { role: { in: [...MENTION_ROLES] }, worksForUserId: null },
          { worksForUserId: person },
          ...(docId
            ? [
                {
                  worksForUserId: { not: null },
                  OR: [
                    { docAuthors: { some: { docId } } },
                    { annotations: { some: { docId, deletedAt: null, status: { not: "DRAFT" as const } } } },
                  ],
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/** Of `userIds`, the ones `actor` may mention in `docId`. */
export async function mentionableAmong(actor: Actor, docId: string | null, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const where = await mentionableUsersWhere(actor, docId);
  if (!where) return [];
  const rows = await prisma.user.findMany({ where: { AND: [where, { id: { in: [...userIds] } }] }, select: { id: true } });
  return rows.map((row) => row.id);
}
