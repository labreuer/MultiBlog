import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { botRoleRefusal, outranks } from "@/lib/bot-rules";
import { isAdmin } from "@/lib/role-checks";
import { colorForSeed } from "@/lib/author-colors";
import { uniqueUserSlug } from "@/lib/user-slug";
import { deriveInitials } from "@/lib/user-initials";
import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";

// docs/MCP.md §21, "Whose account" — making a bot, moving it to another
// person, and the role a bot may be given, as plain functions taking an
// explicit actor: /users' actions (src/app/actions/users.ts) wrap them with
// the session, and the e2e fixtures call them directly, so a test's bot is
// held to the rules a real one is. Each refusal is an ApiError.
//
// **A bot is an account with no password that works for one person**, who
// issues every token it holds (src/lib/bot-rules.ts has the rules as pure
// functions). /users never turns an existing account into a bot: it sets a
// person only on a bot it is creating, and moves one that already has one.
// An imported account nobody has claimed has no password either, and it is
// still a person's.

/** A bot's address is `<slug>@multiblog.invalid`: nothing is mailed to a `.invalid` address. */
export const BOT_EMAIL_DOMAIN = "multiblog.invalid";

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor.role)) throw forbidden("Only an ADMIN manages bots.");
}

/**
 * The person a bot with `botRole` may work for: a live account with a
 * password, since sign-in is by password alone and a password is what makes
 * an account a person's; and one the bot doesn't outrank, who isn't a
 * COMMENTER.
 */
async function requirePerson(personId: string, botRole: Role): Promise<void> {
  const person = await prisma.user.findUnique({ where: { id: personId }, select: { role: true, passwordHash: true } });
  if (!person) throw new ApiError("not_found", "That person's account doesn't exist.");
  if (person.passwordHash === null) {
    throw invalid("A bot works only for an account with a password: one without is a bot itself, or an account nobody has claimed.");
  }
  const refusal = botRoleRefusal(botRole, person.role);
  if (refusal) throw invalid(refusal);
}

/**
 * Makes a bot: a name, its person, and a role no higher than theirs. Its
 * address is made from its slug. `email` is the e2e fixtures' alone, whose
 * accounts carry the suite's prefix so a crashed run's are swept up; the web
 * interface never passes one.
 *
 * Takes named fields and builds the row from them (CLAUDE.md, check:prisma-data).
 */
export async function createBot(
  actor: Actor,
  input: { name: string; personId: string; role: Role; email?: string },
): Promise<{ id: string; email: string; slug: string }> {
  requireAdmin(actor);
  const name = input.name.trim().slice(0, 200);
  if (!name) throw invalid("A bot needs a name.");
  if (!Object.values(Role).includes(input.role)) throw invalid("Invalid role.");
  await requirePerson(input.personId, input.role);

  const slug = await uniqueUserSlug(name, `bot@${BOT_EMAIL_DOMAIN}`);
  const email = input.email ?? `${slug}@${BOT_EMAIL_DOMAIN}`;
  // The slug is free, so this is taken only by an account whose address
  // doesn't follow its slug; the unique index would refuse it anyway.
  if (await prismaIncludingDeleted.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new ApiError("conflict", `An account already has the address ${email}.`);
  }
  const user = await prismaIncludingDeleted.user.create({
    data: {
      email,
      slug,
      name,
      role: input.role,
      color: colorForSeed(email),
      adminInitials: deriveInitials(name, email),
      worksForUserId: input.personId,
    },
    select: { id: true },
  });
  return { id: user.id, email, slug };
}

/**
 * Moves a bot to another person. **It revokes the tokens the previous person
 * issued for it**, in the same transaction: §3's check would refuse them
 * anyway, and revoking keeps a move back from reviving them. Returns how many
 * were revoked.
 */
export async function moveBot(actor: Actor, botId: string, personId: string): Promise<{ revoked: number }> {
  requireAdmin(actor);
  const bot = await prisma.user.findUnique({ where: { id: botId }, select: { role: true, worksForUserId: true } });
  if (!bot) throw new ApiError("not_found", "That account doesn't exist.");
  const previous = bot.worksForUserId;
  if (previous === null) {
    throw invalid("That account is a person's, not a bot. Only a bot works for someone, and an existing account is never made into one.");
  }
  if (previous === personId) return { revoked: 0 };
  await requirePerson(personId, bot.role);

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Conditional on the person it was read with, so two moves at once
    // can't both revoke against a stale one.
    const moved = await tx.user.updateMany({ where: { id: botId, worksForUserId: previous }, data: { worksForUserId: personId } });
    if (moved.count === 0) throw new ApiError("conflict", "The bot was moved meanwhile; reload and try again.");
    const revoked = await tx.apiToken.updateMany({
      where: { userId: botId, createdByUserId: previous, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revoked: revoked.count };
  });
}

/**
 * Refuses promoting a bot above its person, or giving a COMMENTER's bot any
 * higher role. **A demotion is never refused**, of a bot or of a person: a
 * person demoted below their bot stops its tokens on their next call, by §3's
 * check, as demoting the bot itself does.
 */
export async function requireBotRole(userId: string, role: Role): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, worksForUserId: true } });
  if (!user || user.worksForUserId === null || !outranks(role, user.role)) return;
  const person = await prisma.user.findUnique({ where: { id: user.worksForUserId }, select: { role: true } });
  if (!person) throw invalid("That bot's person's account is deleted, so it can't be promoted.");
  const refusal = botRoleRefusal(role, person.role);
  if (refusal) throw invalid(refusal);
}

/**
 * Refuses an invite to a bot. An invite is how an account gets a password,
 * and a CHECK refuses one on a bot; `sendMail` reports a `.invalid` address
 * delivered, so /users would show a link that could never be used.
 */
export async function requireInvitable(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { worksForUserId: true } });
  if (user && user.worksForUserId !== null) throw invalid("A bot is never invited: it has no password, and signs in as no one.");
}
