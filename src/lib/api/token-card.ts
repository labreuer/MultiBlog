import type { ApiScope, ApiTokenClient } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/actor";
import { displayNameOf } from "@/lib/display-name";
import { logOauthLine } from "@/lib/oauth/grant";
import { PINNED_CLIENTS } from "@/lib/oauth/pinned-clients";
import { NEWEST_REFRESH_TOKEN } from "@/lib/oauth/refresh";
import { prisma } from "@/lib/prisma";
import { tokenState, type TokenState } from "./token-state";

// docs/MCP.md §21, "Seeing and ending a connection" — /dashboard's
// Connections card: the tokens a person issued or acts as, and Revoke. It is
// §3's panel for your own tokens, listing and revoking only. It issues
// nothing: an `mb_` secret stays the script's, and a connection comes from
// the consent page.
//
// **A person issues every token of their bots'** and acts as their own
// (`tokenRefusal`, src/lib/bot-rules.ts), so "issued or acts as" is one
// `OR` on the row. No ADMIN sees anyone else's: the card is self-service,
// as the rest of /dashboard is.

/** A token as the card lists it. Revoked ones aren't listed: nothing they hold works, and replaced connections would pile up. */
export type CardToken = {
  id: string;
  name: string;
  /** A connection's client by its name; a header token's by the client it was issued for. */
  client: string;
  /** Whether it is a header token, issued by the script, rather than a connection. */
  header: boolean;
  /** The account it acts as, by name; null when that is the viewer's own. */
  account: string | null;
  scopes: readonly ApiScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  state: Exclude<TokenState, { kind: "revoked" }>;
};

const HEADER_CLIENTS: Record<ApiTokenClient, string> = { CLAUDE_CODE: "Claude Code", CLAUDE_AI: "claude.ai", OTHER: "other" };

const PINNED_NAMES = new Map<string, string>(PINNED_CLIENTS.map(({ document }) => [document.client_id, document.client_name]));

/** The tokens `personId` issued or acts as, newest first, but revoked ones. */
export async function cardTokensOf(personId: string, now: Date): Promise<CardToken[]> {
  const rows = await prisma.apiToken.findMany({
    where: { revokedAt: null, OR: [{ userId: personId }, { createdByUserId: personId }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      scopes: true,
      client: true,
      oauthClientId: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      createdAt: true,
      refreshTokens: NEWEST_REFRESH_TOKEN,
    },
  });
  // The accounts in a query of their own, through the filtered client, as
  // §3's check reads them: a deleted bot's tokens were revoked with it.
  const accountIds = [...new Set(rows.map((row) => row.userId).filter((id) => id !== personId))];
  const registeredIds = [...new Set(rows.flatMap((row) => (row.oauthClientId && !PINNED_NAMES.has(row.oauthClientId) ? [row.oauthClientId] : [])))];
  const [accounts, registered] = await Promise.all([
    accountIds.length > 0 ? prisma.user.findMany({ where: { id: { in: accountIds } }, select: { id: true, name: true } }) : [],
    // A revoked client's name too: its connections were revoked with it, and
    // the name is all that's read.
    registeredIds.length > 0 ? prisma.oauthClient.findMany({ where: { id: { in: registeredIds } }, select: { id: true, name: true } }) : [],
  ]);
  const accountNames = new Map(accounts.map((user) => [user.id, displayNameOf(user)]));
  const clientNames = new Map([...PINNED_NAMES, ...registered.map((client) => [client.id, client.name] as const)]);

  return rows.flatMap((row): CardToken[] => {
    const state = tokenState(row, now);
    if (state.kind === "revoked") return [];
    return [
      {
        id: row.id,
        name: row.name,
        client: row.oauthClientId === null ? HEADER_CLIENTS[row.client] : (clientNames.get(row.oauthClientId) ?? "a client since removed"),
        header: row.oauthClientId === null,
        account: row.userId === personId ? null : (accountNames.get(row.userId) ?? "a deleted account"),
        scopes: row.scopes,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        state,
      },
    ];
  });
}

/**
 * Revokes a token for whoever issued it or acts as it, and nobody else,
 * re-derived here from the actor rather than from what the card showed. It
 * stops at the token's next call: §3's check reads the row on every one, a
 * connection's refresh included. A connection's revocation is logged as the
 * token endpoint logs its own.
 */
export async function revokeToken(actor: Actor, tokenId: string): Promise<void> {
  const token = await prisma.apiToken.findFirst({
    where: { id: tokenId, revokedAt: null, OR: [{ userId: actor.userId }, { createdByUserId: actor.userId }] },
    select: { id: true, prefix: true, oauthClientId: true, userId: true, createdByUserId: true },
  });
  if (!token) throw new Error("No live token of yours has that id.");
  const revoked = await prisma.apiToken.updateMany({ where: { id: token.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (revoked.count === 1 && token.oauthClientId !== null) {
    logOauthLine({
      event: "revoke",
      reason: "dashboard",
      client: token.oauthClientId,
      token: token.prefix,
      user: token.userId,
      issuer: token.createdByUserId,
    });
  }
}
