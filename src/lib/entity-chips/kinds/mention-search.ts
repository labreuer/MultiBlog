import type { Actor } from "@/lib/actor";
import { canUserReadDoc } from "@/lib/doc-authz";
import { prisma } from "@/lib/prisma";
import { resolveChipTarget, type ChipTarget } from "../context-for";
import type { MentionCandidate } from "./mention";
import { mentionableUsersWhere } from "./mention-rule";

// docs/MENTIONS.md, "The menu" — the people a mention menu lists for one
// viewer in one object, as a search. Server-only; the server action and,
// later, MCP's lookup both wrap it, so both list by `mentionableUsersWhere`
// and neither can offer someone the other wouldn't.

export const MENTION_MENU_LIMIT = 8;

const SELECT = {
  id: true,
  name: true,
  adminInitials: true,
  slug: true,
  role: true,
  worksFor: { select: { name: true, slug: true } },
} as const;

/**
 * Up to `MENTION_MENU_LIMIT` people `actor` may mention in `target` whose
 * name or handle contains `query`, the doc's own participants first (its
 * byline and whoever wrote a note on it), then by name. Empty when the actor
 * may not read the target or may not insert mentions.
 *
 * Each row says whether that person could read the doc, since a mention of
 * someone who can't is one they will never see.
 */
export async function mentionCandidates(actor: Actor, target: ChipTarget, query: string): Promise<MentionCandidate[]> {
  const resolved = await resolveChipTarget(actor, target);
  if (!resolved) return [];
  const where = await mentionableUsersWhere(actor, resolved.doc?.id ?? null);
  if (!where) return [];

  const q = query.trim();
  const matching = q
    ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { slug: { contains: q.toLowerCase().replace(/\s+/g, "-") } }] }
    : {};

  const docId = resolved.doc?.id ?? null;
  const participantIds = docId
    ? [
        ...(await prisma.docAuthor.findMany({ where: { docId }, select: { userId: true } })),
        ...(await prisma.annotation.findMany({
          where: { docId, deletedAt: null, status: { not: "DRAFT" } },
          select: { userId: true },
          distinct: ["userId"],
        })),
      ].map((row) => row.userId)
    : [];

  const participants =
    participantIds.length > 0
      ? await prisma.user.findMany({
          where: { AND: [where, matching, { id: { in: participantIds } }] },
          select: SELECT,
          orderBy: { name: "asc" },
          take: MENTION_MENU_LIMIT,
        })
      : [];
  const others =
    participants.length < MENTION_MENU_LIMIT
      ? await prisma.user.findMany({
          where: { AND: [where, matching, { id: { notIn: participantIds } }] },
          select: SELECT,
          orderBy: { name: "asc" },
          take: MENTION_MENU_LIMIT - participants.length,
        })
      : [];

  return Promise.all(
    [...participants, ...others].map(async (user) => ({
      user: {
        id: user.id,
        name: user.name,
        initials: user.adminInitials,
        slug: user.slug,
        deleted: false,
        botOf: user.worksFor ? user.worksFor.name?.trim() || user.worksFor.slug : null,
      },
      canRead: resolved.doc ? await canUserReadDoc(user.id, user.role, resolved.doc) : true,
    })),
  );
}
