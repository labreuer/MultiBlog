import { scheduleMentionRefresh } from "@/lib/entity-chips/refresh";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { AGENTS, botRoleRefusal, outranks } from "@/lib/bot-rules";
import { isAdmin } from "@/lib/role-checks";
import { colorForSeed } from "@/lib/author-colors";
import { displayNameOf } from "@/lib/display-name";
import { uniqueUserSlug } from "@/lib/user-slug";
import { deriveInitials } from "@/lib/user-initials";
import { Prisma } from "@/generated/prisma/client";
import { Role, type Agent } from "@/generated/prisma/enums";
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
//
// **A bot may be for one agent, and a person has one live bot per agent**
// (§21, "A bot's agent"), by a partial unique index. Four writes here can
// meet it: making a bot with an agent, changing a bot's agent, moving a bot
// and restoring a deleted one. Each asks `agentHolder` first and refuses in
// a sentence naming the bot that holds the agent, and each catches the
// index's own refusal, for a write that slipped in between, and asks again.

/** A bot's address is `<slug>@multiblog.invalid`: nothing is mailed to a `.invalid` address. */
export const BOT_EMAIL_DOMAIN = "multiblog.invalid";

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor.role)) throw forbidden("Only an ADMIN manages bots.");
}

type Holder = { id: string; name: string | null; slug: string };

/**
 * `personId`'s live bot for `agent`, other than `exceptId`: the row the
 * index would refuse a second beside. The filtered client reads it, so live
 * is what the index calls live, `deleted_by_user_id IS NULL`.
 */
async function agentHolder(personId: string, agent: Agent, exceptId?: string): Promise<Holder | null> {
  return prisma.user.findFirst({
    where: { worksForUserId: personId, agent, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true, slug: true },
  });
}

/** The refusal each of the four writes gives, naming the bot that holds the agent. */
function agentHeld(holder: Holder, agent: Agent, lead: string, then = ""): ApiError {
  return new ApiError(
    "conflict",
    `${lead} already has a bot for ${AGENTS[agent].name}: ${displayNameOf(holder)} (${holder.slug}). A person has one live bot per agent.${then}`,
    { botId: holder.id },
  );
}

/** Refuses a write that would give `personId` a second live bot for `agent`. */
async function requireAgentFree(personId: string, agent: Agent, exceptId: string | undefined, lead: string, then?: string): Promise<void> {
  const holder = await agentHolder(personId, agent, exceptId);
  if (holder) throw agentHeld(holder, agent, lead, then);
}

/**
 * Runs a write the index can refuse. A duplicate (`P2002`) is the index's
 * only when the person now has another live bot for the agent, so that is
 * asked again, and the write refused as `requireAgentFree` would have. The
 * re-read says which collision it was, not the error's metadata, which a
 * driver adapter may report differently. Any other duplicate is rethrown.
 */
async function withAgentIndex<T>(
  held: { personId: string; agent: Agent | null; exceptId?: string; lead: string; then?: string },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (held.agent !== null && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await requireAgentFree(held.personId, held.agent, held.exceptId, held.lead, held.then);
    }
    throw err;
  }
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
 * Makes a bot: a name, its person, a role no higher than theirs, and
 * optionally the agent it is for. Its address is made from its slug. `email`
 * is the e2e fixtures' alone, whose accounts carry the suite's prefix so a
 * crashed run's are swept up; the web interface never passes one.
 *
 * **With an agent, its initials are that agent's** (`AGENTS`), as for a bot
 * made at Approve, so every Claude bot has the same ones whoever made it.
 * Without one they are made from its name.
 *
 * Takes named fields and builds the row from them (CLAUDE.md, check:prisma-data).
 */
export async function createBot(
  actor: Actor,
  input: { name: string; personId: string; role: Role; agent?: Agent | null; email?: string },
): Promise<{ id: string; email: string; slug: string }> {
  requireAdmin(actor);
  const name = input.name.trim().slice(0, 200);
  if (!name) throw invalid("A bot needs a name.");
  if (!Object.values(Role).includes(input.role)) throw invalid("Invalid role.");
  const agent = input.agent ?? null;
  if (agent !== null && !Object.hasOwn(AGENTS, agent)) throw invalid("Invalid agent.");
  await requirePerson(input.personId, input.role);
  const held = { personId: input.personId, agent, lead: "That person" };
  if (agent !== null) await requireAgentFree(held.personId, agent, undefined, held.lead);

  const slug = await uniqueUserSlug(name, `bot@${BOT_EMAIL_DOMAIN}`);
  const email = input.email ?? `${slug}@${BOT_EMAIL_DOMAIN}`;
  // The slug is free, so this is taken only by an account whose address
  // doesn't follow its slug; the unique index would refuse it anyway.
  if (await prismaIncludingDeleted.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new ApiError("conflict", `An account already has the address ${email}.`);
  }
  const user = await withAgentIndex(held, () =>
    prismaIncludingDeleted.user.create({
      data: {
        email,
        slug,
        name,
        role: input.role,
        color: colorForSeed(email),
        adminInitials: agent === null ? deriveInitials(name, email) : AGENTS[agent].initials,
        worksForUserId: input.personId,
        agent,
      },
      select: { id: true },
    }),
  );
  return { id: user.id, email, slug };
}

/**
 * Changes the agent a bot is for, or clears it. **Only a bot has one**: an
 * account that works for no one is refused, as `moveBot` refuses it, which
 * is what keeps `user.agent` to bots where no CHECK can (§21, "A bot's
 * agent"). The bot's name and initials stay as they are: each has a cell of
 * its own on /users.
 */
export async function setBotAgent(actor: Actor, botId: string, agent: Agent | null): Promise<void> {
  requireAdmin(actor);
  if (agent !== null && !Object.hasOwn(AGENTS, agent)) throw invalid("Invalid agent.");
  const bot = await prisma.user.findUnique({ where: { id: botId }, select: { worksForUserId: true, agent: true } });
  if (!bot) throw new ApiError("not_found", "That account doesn't exist.");
  const personId = bot.worksForUserId;
  if (personId === null) throw invalid("That account is a person's, not a bot. Only a bot is for an agent.");
  if (bot.agent === agent) return;
  const held = { personId, agent, exceptId: botId, lead: "Its person" };
  if (agent !== null) await requireAgentFree(personId, agent, botId, held.lead);
  await withAgentIndex(held, async () => {
    // Conditional on the person it was read with, so a move meanwhile can't
    // leave an agent on a row the check above never asked about.
    const changed = await prisma.user.updateMany({ where: { id: botId, worksForUserId: personId }, data: { agent } });
    if (changed.count === 0) throw new ApiError("conflict", "The bot was moved or deleted meanwhile; reload and try again.");
  });
}

/**
 * Moves a bot to another person. **It revokes the tokens the previous person
 * issued for it**, in the same transaction: §3's check would refuse them
 * anyway, and revoking keeps a move back from reviving them. Returns how many
 * were revoked.
 *
 * **It keeps its agent**, so a move to a person who already has a live bot
 * for that agent is refused.
 */
export async function moveBot(actor: Actor, botId: string, personId: string): Promise<{ revoked: number }> {
  requireAdmin(actor);
  const bot = await prisma.user.findUnique({ where: { id: botId }, select: { role: true, worksForUserId: true, agent: true } });
  if (!bot) throw new ApiError("not_found", "That account doesn't exist.");
  const previous = bot.worksForUserId;
  if (previous === null) {
    throw invalid("That account is a person's, not a bot. Only a bot works for someone, and an existing account is never made into one.");
  }
  if (previous === personId) return { revoked: 0 };
  await requirePerson(personId, bot.role);
  const held = { personId, agent: bot.agent, exceptId: botId, lead: "The person it would move to" };
  if (bot.agent !== null) await requireAgentFree(personId, bot.agent, botId, held.lead);

  const now = new Date();
  const result = await withAgentIndex(held, () =>
    prisma.$transaction(async (tx) => {
      // Conditional on the person and the agent it was read with, so two
      // moves at once can't both revoke against a stale one, and the agent
      // the check above asked about is the one that moves.
      const moved = await tx.user.updateMany({
        where: { id: botId, worksForUserId: previous, agent: bot.agent },
        data: { worksForUserId: personId },
      });
      if (moved.count === 0) throw new ApiError("conflict", "The bot was changed meanwhile; reload and try again.");
      const revoked = await tx.apiToken.updateMany({
        where: { userId: botId, createdByUserId: previous, revokedAt: null },
        data: { revokedAt: now },
      });
      return { revoked: revoked.count };
    }),
  );
  // A bot's mention can name the person it works for (docs/MENTIONS.md, "Same labels").
  scheduleMentionRefresh([botId]);
  return result;
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
 * Restores a deleted account, as /users' Restore does: the row alone, since
 * no token comes back (src/lib/user-delete.ts). **A deleted bot freed its
 * agent**, so its person may have made a new bot for it since, and restoring
 * the old one would make two: that is refused, naming the new one. An ADMIN
 * who wants the old bot back deletes the new one first, since a deleted
 * row's other controls are disabled and its agent can't be cleared instead.
 */
export async function restoreAccount(actor: Actor, userId: string): Promise<void> {
  requireAdmin(actor);
  const user = await prismaIncludingDeleted.user.findUnique({ where: { id: userId }, select: { worksForUserId: true, agent: true } });
  if (!user) throw new ApiError("not_found", "That account doesn't exist.");
  const restore = () => prismaIncludingDeleted.user.update({ where: { id: userId }, data: { deletedByUserId: null, deletedAt: null }, select: { id: true } });
  if (user.worksForUserId === null || user.agent === null) {
    await restore();
    return;
  }
  const held = {
    personId: user.worksForUserId,
    agent: user.agent,
    exceptId: userId,
    lead: "Its person",
    then: " Delete that one first, to restore this one.",
  };
  await requireAgentFree(held.personId, held.agent, userId, held.lead, held.then);
  await withAgentIndex(held, restore);
}

/**
 * Refuses an invite to a bot, and to any account with an agent. An invite is
 * how an account gets a password, and a CHECK refuses one on each;
 * `sendMail` reports a `.invalid` address delivered, so /users would show a
 * link that could never be used. An account with an agent that works for no
 * one is a bot whose person was hard-deleted: without this its invite would
 * be sent, and accepting it would fail on the CHECK with no sentence for
 * whoever followed the link.
 */
export async function requireInvitable(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { worksForUserId: true, agent: true } });
  if (!user) return;
  if (user.worksForUserId !== null) throw invalid("A bot is never invited: it has no password, and signs in as no one.");
  if (user.agent !== null) {
    throw invalid(`An account for ${AGENTS[user.agent].name} is never invited: it was a bot, and an account with an agent has no password.`);
  }
}
