import type { Agent, Role } from "@/generated/prisma/enums";

// docs/MCP.md §21, "Whose account" — the rules that hold a bot to its person,
// as pure functions of the rows involved. §3's token check
// (src/lib/api/tokens.ts) and the issuing of a token apply `tokenRefusal`;
// /users' bot actions (src/lib/bots.ts) apply `botRoleRefusal`; the consent
// page offers only the bots `tokenRefusal` accepts, and so does the code's
// redemption. Browser-safe, so /users can offer only the roles a bot may
// have.
//
// **A bot is an account that works for someone** (`user.works_for_user_id`),
// and a CHECK keeps it from having a password. Its person is the issuer of
// every token it holds; a person's own token is issued by that person.

/**
 * Every role, highest first: the order `Role` is declared in, which is
 * privilege order (src/lib/users-query.ts). A unit test holds the two to
 * each other, so a role added to the enum can't be left unranked.
 */
export const ROLES_BY_RANK: readonly Role[] = ["ADMIN", "EDITOR", "AUTHOR", "AUTHORIZED", "COMMENTER"];

/** Whether `a` ranks above `b`. */
export function outranks(a: Role, b: Role): boolean {
  return ROLES_BY_RANK.indexOf(a) < ROLES_BY_RANK.indexOf(b);
}

/**
 * Why a bot with `botRole` may not work for a person with `personRole`, or
 * null if it may. **A COMMENTER has no bot, and a bot never outranks its
 * person**: a bot's tokens act with its own role, so a bot above its person
 * would let the person do through it what their own role forbids.
 */
export function botRoleRefusal(botRole: Role, personRole: Role): string | null {
  if (personRole === "COMMENTER") return "A COMMENTER can't have a bot.";
  if (outranks(botRole, personRole)) return `A bot can't rank above the person it works for (${botRole} is above ${personRole}).`;
  return null;
}

/** The roles a bot working for someone with `personRole` may have, highest first; none for a COMMENTER. */
export function botRolesFor(personRole: Role): Role[] {
  return ROLES_BY_RANK.filter((role) => botRoleRefusal(role, personRole) === null);
}

/**
 * Each agent's name and the initials its bots carry (§21, "Which agent a
 * client is"): the one table /users' select, the consent page and both ways
 * of making a bot read. **The initials are picked, not made from the name**:
 * `deriveInitials` would give `CL`, `CH` and `AN`. Antigravity's is the
 * client's name, not "Gemini": its person picks the model per conversation,
 * so the client's name is the only one always true of what writes.
 */
export const AGENTS: Readonly<Record<Agent, { name: string; initials: string }>> = {
  CLAUDE: { name: "Claude", initials: "CLD" },
  CHATGPT: { name: "ChatGPT", initials: "GPT" },
  ANTIGRAVITY: { name: "Antigravity", initials: "AGV" },
};

/**
 * The role a bot is made with when a person approves a connection (§21,
 * "Making it, at Approve"): the one constant the consent page's offer and
 * `ensureAgentBot`'s gate both read. Who may have such a bot is then
 * `botRoleRefusal(AGENT_BOT_ROLE, theirRole)`, an AUTHOR or above, with no
 * second statement of it to drift. Never the person's own role: a bot's
 * tokens act with the bot's, so an ADMIN's agent made an ADMIN would reach
 * everything that role widens, which nobody chose.
 */
export const AGENT_BOT_ROLE: Role = "AUTHOR";

/**
 * The name of a bot made at Approve: its agent's, then its person's initials,
 * "Claude (LB)". Most surfaces show an account by its name alone, a byline or
 * a note's card, and two people's bots both called "Claude" would read alike
 * in all of them.
 */
export function agentBotName(agent: Agent, personInitials: string): string {
  const initials = personInitials.trim();
  return initials ? `${AGENTS[agent].name} (${initials})` : AGENTS[agent].name;
}

/** Every agent, in the order the enum declares them; a unit test holds the two to each other. */
export const AGENT_KEYS = Object.keys(AGENTS) as readonly Agent[];

/** An agent from a form's or a caller's value, or null for anything else: an action is sent whatever its caller likes. */
export function parseAgent(value: unknown): Agent | null {
  return typeof value === "string" && Object.hasOwn(AGENTS, value) ? (value as Agent) : null;
}

/** The half of an account §3's check reads: `mcpAllowed` is `user.mcp_allowed`, which an ADMIN clears on /users. */
export type TokenAccount = { id: string; role: Role; worksForUserId: string | null; mcpAllowed: boolean };
export type TokenIssuer = { id: string; role: Role; mcpAllowed: boolean };

/**
 * Why a token is refused, for a caller that says so in words of its own, as
 * the consent page does:
 *
 * - `issuer`: it wasn't issued by the account's person;
 * - `issuer-off`: connections are turned off for whoever issued it;
 * - `account-off`: they are turned off for the account itself, a bot;
 * - `commenter`: its person is a COMMENTER, who has no bot;
 * - `outranks`: the bot ranks above its person.
 */
export type TokenRefusal = { reason: "issuer" | "issuer-off" | "account-off" | "commenter" | "outranks"; message: string };

const CONNECTIONS_OFF = "An ADMIN has turned connections off for";

/**
 * Why §3's check refuses a token held by `account` and issued by `issuer`,
 * or null if it accepts it. **The issuer must be the account's person**,
 * `works_for_user_id ?? the account's own id`: one comparison, so a bot's
 * token issued by the bot itself is refused as surely as one issued by a
 * stranger.
 *
 * **Then neither may have connections turned off** (§21, "Connections turned
 * off for an account"). A person issues their own token and every one of
 * their bots', so turning a person's off stops all of those, and turning a
 * bot's off stops that bot alone.
 *
 * A bot's token is then refused while its person is a COMMENTER or ranks
 * below it. Each of these is read on every call, so clearing the flag or
 * demoting either account takes effect on the token's next one.
 */
export function tokenRefusalOf(account: TokenAccount, issuer: TokenIssuer): TokenRefusal | null {
  const bot = account.worksForUserId !== null;
  if (issuer.id !== (account.worksForUserId ?? account.id)) {
    return {
      reason: "issuer",
      message: bot ? "A bot's token must be issued by the person it works for." : "A person's token must be issued by that person.",
    };
  }
  if (!issuer.mcpAllowed) {
    return { reason: "issuer-off", message: `${CONNECTIONS_OFF} ${bot ? "the person this bot works for" : "this account"}.` };
  }
  if (!bot) return null;
  if (!account.mcpAllowed) return { reason: "account-off", message: `${CONNECTIONS_OFF} this bot.` };
  const message = botRoleRefusal(account.role, issuer.role);
  if (message === null) return null;
  return { reason: issuer.role === "COMMENTER" ? "commenter" : "outranks", message };
}

/** `tokenRefusalOf`'s sentence alone, or null if the check accepts the token. */
export function tokenRefusal(account: TokenAccount, issuer: TokenIssuer): string | null {
  return tokenRefusalOf(account, issuer)?.message ?? null;
}
