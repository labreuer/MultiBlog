import type { Agent, Role } from "@/generated/prisma/enums";
import { AGENT_BOT_ROLE, agentBotName, botRoleRefusal, type TokenRefusal } from "@/lib/bot-rules";

// docs/MCP.md §21, "The consent page" — what the page offers a person to
// connect as, from the bots that work for them and the agent the asking
// client is. Pure, so the rule is unit-tested; src/lib/oauth/consent.ts reads
// the rows, and `ensureAgentBot` (src/lib/bots.ts) holds Approve to the same
// rule, so the page offers exactly what Approve will do.

/** A bot as the page lists it, with the agent it is for, if any. */
export type Bot = { id: string; name: string | null; slug: string; agent: Agent | null };

/** A bot the page can't offer, with why §3's check would refuse its token. */
export type RefusedBot = Bot & { reason: TokenRefusal["reason"] };

export type ConsentOffer = {
  /** The offered bots in the order the list shows them: the person's bot for the client's agent first. */
  bots: Bot[];
  /** The name of the new bot the list offers first, value `new`; null when it offers none. */
  newBot: string | null;
  /** The offered bots that are another agent's, each of which gets a line saying whose name it signs. */
  otherAgents: Bot[];
  /** The person's bot for the client's agent, when §3's check refuses it: why no new one is offered. */
  held: RefusedBot | null;
};

/**
 * What the page offers `person` for a client that is `clientAgent`'s.
 *
 * - **Their bot for that agent comes first**, and so is the one chosen.
 * - **With none, and none refused, a new one is offered first**, to a person
 *   who may have a bot of the role one is made with: an AUTHOR or above. An
 *   AUTHORIZED person is offered none, since such a bot would outrank them,
 *   and neither is a person whose connections are turned off.
 * - **A refused bot for the agent holds it**: the index allows one live bot
 *   per agent per person, and a second would hide the first.
 * - **A client that is no agent's gets the bots as they are**, and nothing
 *   else: no bot is made for it, and nothing says whose a bot is.
 */
export function consentOffer(
  person: { role: Role; adminInitials: string; mcpAllowed: boolean },
  clientAgent: Agent | null,
  offered: readonly Bot[],
  refused: readonly RefusedBot[],
): ConsentOffer {
  if (clientAgent === null) return { bots: [...offered], newBot: null, otherAgents: [], held: null };
  const mine = offered.filter((bot) => bot.agent === clientAgent);
  const held = refused.find((bot) => bot.agent === clientAgent) ?? null;
  const mayHaveOne = person.mcpAllowed && botRoleRefusal(AGENT_BOT_ROLE, person.role) === null;
  return {
    bots: [...mine, ...offered.filter((bot) => bot.agent !== clientAgent)],
    newBot: mine.length === 0 && held === null && mayHaveOne ? agentBotName(clientAgent, person.adminInitials) : null,
    otherAgents: offered.filter((bot) => bot.agent !== null && bot.agent !== clientAgent),
    held,
  };
}
