import { prisma } from "@/lib/prisma";

// docs/MCP.md §21, "Which clients" — who may ask for a connection. A request
// names its client by `client_id`, and an unknown one is refused before
// anything else. Every client is public: PKCE is the proof on the code.
//
// Two kinds so far: Claude's published identity, pinned here, and a client
// registered by hand, a row in `oauth_client`. Claude Code's identity is an
// unknown client until it is pinned beside Claude's (§21, Build order 9).

/** A client a request may name. */
export type OauthClientInfo = {
  clientId: string;
  name: string;
  redirectUris: readonly string[];
  /** The `api_token.client` its connections get: never CLAUDE_CODE (§21, "Whose account"). */
  kind: "CLAUDE_AI" | "OTHER";
};

/**
 * Claude's client ID metadata document, as
 * https://claude.ai/oauth/mcp-oauth-client-metadata served it on
 * 2026-10-14. **Pinned, not fetched**: a request naming that URL is answered
 * from this constant, so the authorize path makes no outbound request and
 * nobody can make the server fetch a URL of their choosing. Every Claude app
 * uses it: the web, Desktop and mobile.
 *
 * Its `jwt-bearer` grant is one this server doesn't offer, and its
 * `token_endpoint_auth_method` of `none` is what a pin of a public client
 * rests on; if Anthropic ever names a key here, the token endpoint must
 * verify it (§21, Open).
 */
export const CLAUDE_AI_METADATA = {
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
} as const;

/** The pinned identities, by client_id. Any other URL is an unknown client: the pins are an allowlist. */
const PINNED = new Map<string, OauthClientInfo>([
  [
    CLAUDE_AI_METADATA.client_id,
    {
      clientId: CLAUDE_AI_METADATA.client_id,
      name: CLAUDE_AI_METADATA.client_name,
      redirectUris: CLAUDE_AI_METADATA.redirect_uris,
      kind: "CLAUDE_AI",
    },
  ],
]);

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
