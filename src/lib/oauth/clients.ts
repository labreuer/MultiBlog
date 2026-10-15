import { prisma } from "@/lib/prisma";
import { redirectUriRefusal } from "./authorize-request";
import { PINNED_CLIENTS } from "./pinned-clients";

// docs/MCP.md §21, "Which clients" — who may ask for a connection. A request
// names its client by `client_id`, and an unknown one is refused before
// anything else. Every client is public: PKCE is the proof on the code.
//
// Two kinds: the published identities pinned in pinned-clients.ts, Claude's
// and Claude Code's, and a client registered by hand, a row in
// `oauth_client` that scripts/oauth-client.ts registers, lists and revokes.

/** A client a request may name. */
export type OauthClientInfo = {
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  /** The `api_token.client` its connections get: never CLAUDE_CODE (§21, "Whose account"). */
  kind: "CLAUDE_AI" | "OTHER";
};

/** The pinned identities, by client_id. Any other URL is an unknown client: the pins are an allowlist. */
const PINNED = new Map<string, OauthClientInfo>(
  PINNED_CLIENTS.map(({ document, kind }) => [
    document.client_id,
    { clientId: document.client_id, name: document.client_name, redirectUris: document.redirect_uris, kind },
  ]),
);

/**
 * Whether a new connection through `client` replaces the bot's last one
 * through it (§21, "The token endpoint"). A claude.ai client's does, whether
 * the pinned identity or one registered by hand as its fallback: reconnecting
 * is how claude.ai recovers from most failures, and each reconnect would
 * otherwise leave the old refresh token good for up to 90 days, wherever
 * claude.ai keeps it.
 */
export function replacesConnections(client: OauthClientInfo): boolean {
  return client.kind === "CLAUDE_AI";
}

/** No client_id is longer: a pinned URL, or a cuid. */
const MAX_CLIENT_ID_LENGTH = 200;

/** The client a request names, or null for an unknown or revoked one. */
export async function findClient(clientId: string): Promise<OauthClientInfo | null> {
  const pinned = PINNED.get(clientId);
  if (pinned) return pinned;
  if (clientId.length > MAX_CLIENT_ID_LENGTH) return null;
  const row = await prisma.oauthClient.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, redirectUris: true, client: true, revokedAt: true },
  });
  // CLAUDE_CODE is refused by a CHECK on the table; this keeps the type honest.
  if (!row || row.revokedAt !== null || row.client === "CLAUDE_CODE") return null;
  return { clientId: row.id, name: row.name, redirectUris: row.redirectUris, kind: row.client };
}

/** No client registered by hand has a longer name; the consent page shows it whole. */
const MAX_CLIENT_NAME_LENGTH = 100;

/**
 * Registers a client by hand: a name, its redirect URIs, and the kind its
 * connections get. `CLAUDE_AI` is for claude.ai's fallback, its "Use your own
 * OAuth client" option, which keeps claude.ai connecting should its published
 * identity stop matching the pin; `OTHER` for anything else, the MCP
 * Inspector say. Throws, with a message for whoever runs the script, on a
 * redirect URI `redirectUriRefusal` refuses. Returns the new client_id.
 *
 * Takes named fields and builds the row from them (CLAUDE.md, check:prisma-data).
 */
export async function registerClient(opts: { name: string; redirectUris: readonly string[]; kind: "CLAUDE_AI" | "OTHER" }): Promise<string> {
  const name = opts.name.trim();
  if (!name) throw new Error("A client needs a name: the consent page shows it.");
  if (name.length > MAX_CLIENT_NAME_LENGTH) throw new Error(`A client's name is at most ${MAX_CLIENT_NAME_LENGTH} characters.`);
  const redirectUris = [...new Set(opts.redirectUris)];
  if (redirectUris.length === 0) throw new Error("A client needs at least one redirect URI.");
  for (const uri of redirectUris) {
    const refusal = redirectUriRefusal(uri);
    if (refusal) throw new Error(refusal);
  }
  const row = await prisma.oauthClient.create({ data: { name, redirectUris, client: opts.kind }, select: { id: true } });
  return row.id;
}

/**
 * Revokes a client registered by hand, and every connection made through it,
 * in one transaction. A code it holds is refused at the token endpoint from
 * then on, since `findClient` no longer knows the client. Null when no live
 * client has that id; a pinned identity can't be revoked.
 */
export async function revokeClient(clientId: string): Promise<{ connections: number } | null> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const revoked = await tx.oauthClient.updateMany({ where: { id: clientId, revokedAt: null }, data: { revokedAt: now } });
    if (revoked.count === 0) return null;
    const connections = await tx.apiToken.updateMany({ where: { oauthClientId: clientId, revokedAt: null }, data: { revokedAt: now } });
    return { connections: connections.count };
  });
}
