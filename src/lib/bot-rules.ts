import type { Role } from "@/generated/prisma/enums";

// docs/MCP.md §21, "Whose account" — the rules that hold a bot to its person,
// as pure functions of the rows involved. §3's token check
// (src/lib/api/tokens.ts) and the issuing of a token apply `tokenRefusal`;
// /users' bot actions (src/lib/bots.ts) apply `botRoleRefusal`; the consent
// page offers only the bots `botRoleRefusal` accepts. Browser-safe, so
// /users can offer only the roles a bot may have.
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

export type TokenAccount = { id: string; role: Role; worksForUserId: string | null };

/**
 * Why §3's check refuses a token held by `account` and issued by `issuer`,
 * or null if it accepts it. **The issuer must be the account's person**,
 * `works_for_user_id ?? the account's own id`: one comparison, so a bot's
 * token issued by the bot itself is refused as surely as one issued by a
 * stranger. A bot's token is then refused while its person is a COMMENTER or
 * ranks below it, so demoting either takes effect on the token's next call.
 */
export function tokenRefusal(account: TokenAccount, issuer: { id: string; role: Role }): string | null {
  if (account.worksForUserId === null) {
    return issuer.id === account.id ? null : "A person's token must be issued by that person.";
  }
  if (issuer.id !== account.worksForUserId) return "A bot's token must be issued by the person it works for.";
  return botRoleRefusal(account.role, issuer.role);
}
