// docs/MCP.md §21, "Which clients" — the published identities this server
// knows, as their client ID metadata documents (CIMD) served them: Claude's,
// Claude Code's, ChatGPT's and Google Antigravity's. **Pinned,
// not fetched**: a request naming either URL is answered from the constant
// here, so the authorize path makes no outbound request and nobody can make
// the server fetch a URL of their choosing. The two are an allowlist: any
// other URL is an unknown client.
//
// The cost is that a client's maker can change its document. `scripts/check-oauth-clients.ts`
// fetches each and compares it with its pin (`documentDrift`, client-drift.ts),
// and `deploy/deploy.sh` runs it on every deploy; a change is then an edit
// here. Pure, with no database, so that script and the unit tests can load it.

import type { Agent } from "@/generated/prisma/enums";

/** The fields of a client ID metadata document that the pins carry. */
export type ClientMetadataDocument = {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: readonly string[];
  grant_types: readonly string[];
  response_types: readonly string[];
  token_endpoint_auth_method: string;
  /** ChatGPT's alone: the methods it can use, of which it picks one this server lists. */
  token_endpoint_auth_methods_supported?: readonly string[];
  token_endpoint_auth_signing_alg?: string;
  jwks_uri?: string;
  logo_uri?: string;
};

/**
 * The `api_token.client` a client's connections get: never CLAUDE_CODE
 * (§21, "Whose account"). CLAUDE_AI and CHATGPT each decide a read bound and
 * that a new connection replaces the last; OTHER decides neither.
 */
export type OauthClientKind = "CLAUDE_AI" | "CHATGPT" | "OTHER";

/**
 * Claude's identity, as https://claude.ai/oauth/mcp-oauth-client-metadata
 * served it on 2026-10-14. Every Claude app uses it: the web, Desktop and
 * mobile.
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
} as const satisfies ClientMetadataDocument;

/**
 * Claude Code's identity, as https://claude.ai/oauth/claude-code-client-metadata
 * served it on 2026-10-15: what Claude Code uses when a person signs in to the
 * server with `/mcp` instead of configuring §5's header. Both redirect URIs
 * are loopback ones, matched on any port.
 *
 * **Its connections are `other`, never `claude-code`.** Any program on the
 * machine can answer a loopback redirect, so a claim to be Claude Code can't
 * be checked, and the consent page warns that the connection goes to a
 * program on the person's own computer.
 */
export const CLAUDE_CODE_METADATA = {
  client_id: "https://claude.ai/oauth/claude-code-client-metadata",
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
} as const satisfies ClientMetadataDocument;

/**
 * ChatGPT's identity, as https://chatgpt.com/oauth/client.json served it on
 * 2026-11-16: the one ChatGPT presents when the authorization server meets
 * RFC 9207's issuer identification, which this one does (`iss` on every
 * response, and the metadata's issuer exactly the resource's
 * `authorization_servers`). Otherwise ChatGPT would use a per-connection
 * `https://chatgpt.com/oauth/<callback_id>/client.json` and redirect URI,
 * which no pin could name.
 *
 * **A public client here, though its document names a key.** It lists `none`
 * and `private_key_jwt` among the methods it can use and picks one that the
 * server's metadata lists, which is `none` alone, so PKCE is the proof on its
 * code as on every other client's. Its singular `token_endpoint_auth_method`
 * is the older field, kept for clients that read only that one. Should the
 * plural list ever drop `none`, the drift check warns, and the token endpoint
 * would have to verify an assertion against `jwks_uri` (§21, Open).
 *
 * Its `jwt-bearer` grant is one this server doesn't offer, as Claude's is.
 */
export const CHATGPT_METADATA = {
  client_id: "https://chatgpt.com/oauth/client.json",
  client_name: "ChatGPT",
  client_uri: "https://chatgpt.com/",
  redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
  grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  response_types: ["code"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
} as const satisfies ClientMetadataDocument;

/**
 * Google Antigravity's identity, as
 * https://antigravity.google/oauth/client-metadata.json served it on
 * 2026-11-16: what its app, IDE and CLI (`agy`) use, the way a free Google
 * account reaches Gemini with an MCP server. Its redirect URI is a hosted
 * page that shows the code for the person to paste back into Antigravity.
 *
 * **Its connections are `other`, and don't replace each other**: one person
 * may sign in from more than one machine, as with Claude Code.
 */
export const ANTIGRAVITY_METADATA = {
  client_id: "https://antigravity.google/oauth/client-metadata.json",
  client_name: "Google Antigravity",
  client_uri: "https://antigravity.google",
  redirect_uris: ["https://antigravity.google/oauth-callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  logo_uri: "https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png",
} as const satisfies ClientMetadataDocument;

/**
 * A pinned identity, the `api_token.client` its connections get, and the AI
 * agent it is (§21, "Which agent a client is").
 *
 * **The agent is a field of its own, not the kind.** A kind decides the tools
 * a token lists and whether a connection replaces the last one; an agent
 * decides whose name a bot carries, and which bot the consent page puts
 * first. The two disagree for Claude Code, whose kind is OTHER and whose
 * agent is Claude, and for Antigravity, an OTHER with an agent of its own.
 */
export type PinnedClient = { document: ClientMetadataDocument; kind: OauthClientKind; agent: Agent };

export const PINNED_CLIENTS: readonly PinnedClient[] = [
  { document: CLAUDE_AI_METADATA, kind: "CLAUDE_AI", agent: "CLAUDE" },
  { document: CLAUDE_CODE_METADATA, kind: "OTHER", agent: "CLAUDE" },
  { document: CHATGPT_METADATA, kind: "CHATGPT", agent: "CHATGPT" },
  { document: ANTIGRAVITY_METADATA, kind: "OTHER", agent: "ANTIGRAVITY" },
];

/**
 * The agent a client registered by hand has when it is given none: its
 * kind's, for the two kinds that are one service's fallback, and none for an
 * OTHER, which is anything a person connects.
 */
export function defaultAgentOf(kind: OauthClientKind): Agent | null {
  if (kind === "CLAUDE_AI") return "CLAUDE";
  if (kind === "CHATGPT") return "CHATGPT";
  return null;
}

/**
 * Why a client of `kind` can't be `agent`'s, or null if it can. A CLAUDE_AI
 * or CHATGPT kind sets the read bound and the replacing of a connection for
 * that one service, so it is that service's agent and no other's. An OTHER
 * takes any agent, which is how a fallback registered for Antigravity or
 * Claude Code gets its own.
 */
export function agentKindRefusal(kind: OauthClientKind, agent: Agent): string | null {
  const own = defaultAgentOf(kind);
  if (own === null || own === agent) return null;
  return `A ${kind} client is ${own}'s: its kind sets that service's read bound and the replacing of its connections, so it can't be ${agent}'s.`;
}
