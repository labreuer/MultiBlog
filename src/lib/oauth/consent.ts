import { createHash, randomBytes } from "node:crypto";
import type { ApiScope, Role } from "@/generated/prisma/enums";
import { auth } from "@/lib/auth";
import { botRoleRefusal } from "@/lib/bot-rules";
import { prisma } from "@/lib/prisma";
import { replacesConnections, type OauthClientInfo } from "./clients";
import { NEWEST_REFRESH_TOKEN } from "./refresh";
import { hasLapsed } from "./rotation";

// docs/MCP.md §21, "Whose account" and "The consent page" — the bots a
// person may connect, and the code Approve mints.
//
// **A connection acts as a bot, never as the person approving it**, so what
// claude.ai writes carries Claude's name and it reads only what has been
// shared with Claude. The page offers only the bots that work for whoever is
// signed in, and that §3's check would accept (src/lib/bot-rules.ts), and
// that person becomes the connection's issuer.

/** How long a code is good for, and it is good once. */
export const CODE_TTL_MS = 2 * 60_000;

export type Bot = { id: string; name: string | null; slug: string };

export type Person = { id: string; name: string | null; role: Role };

/**
 * Whoever is signed in, if their account is still live. The row is read, not
 * just the session: a session outlives a deleted account (src/lib/prisma.ts's
 * filter leaves one out), and carries the role from sign-in, not the current one.
 */
export async function signedInPerson(): Promise<Person | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true, role: true } });
}

/**
 * The live accounts that work for `person`, by name, leaving out any whose
 * tokens §3's check would refuse: one ranked above them, or every one of a
 * COMMENTER's. A deleted bot is left out by the soft-delete filter
 * (src/lib/prisma.ts).
 */
export async function botsFor(person: Person): Promise<Bot[]> {
  const bots = await prisma.user.findMany({
    where: { worksForUserId: person.id },
    select: { id: true, name: true, slug: true, role: true },
    orderBy: [{ name: "asc" }, { slug: "asc" }],
  });
  return bots.filter((bot) => botRoleRefusal(bot.role, person.role) === null).map(({ id, name, slug }) => ({ id, name, slug }));
}

/**
 * When a client's new connection replaces the bot's last one through it
 * (`replacesConnections`), the bots among `botIds` that `personId` already
 * connected through it, each with when its connection was made, so the page
 * can say before Approve that approving replaces that connection (§21, "The
 * token endpoint"). A revoked or lapsed connection is left out: nothing it
 * holds still works.
 */
export async function connectedBots(client: OauthClientInfo, personId: string, botIds: readonly string[]): Promise<Map<string, Date>> {
  const made = new Map<string, Date>();
  if (!replacesConnections(client) || botIds.length === 0) return made;
  const connections = await prisma.apiToken.findMany({
    where: { userId: { in: [...botIds] }, createdByUserId: personId, oauthClientId: client.clientId, revokedAt: null },
    select: { userId: true, createdAt: true, refreshTokens: NEWEST_REFRESH_TOKEN },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();
  for (const connection of connections) {
    if (!hasLapsed(connection.refreshTokens, now)) made.set(connection.userId, connection.createdAt);
  }
  return made;
}

/** Whether `botId` is a live account working for `person`, one `botsFor` would offer. */
export async function worksFor(botId: string, person: Person): Promise<boolean> {
  const bot = await prisma.user.findUnique({ where: { id: botId }, select: { worksForUserId: true, role: true } });
  return bot !== null && bot.worksForUserId === person.id && botRoleRefusal(bot.role, person.role) === null;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Mints a code for an approved request: 32 random bytes, kept as their
 * SHA-256 with everything the token endpoint will hold the redemption to.
 * The code itself is returned once, for the redirect.
 *
 * Takes named fields and builds the row from them (CLAUDE.md, check:prisma-data).
 */
export async function mintAuthorizationCode(opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: readonly ApiScope[];
  botId: string;
  issuerId: string;
}): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await prisma.oauthCode.create({
    data: {
      codeHash: hashCode(code),
      clientId: opts.clientId,
      redirectUri: opts.redirectUri,
      codeChallenge: opts.codeChallenge,
      scopes: [...opts.scopes],
      userId: opts.botId,
      issuerId: opts.issuerId,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}
