// docs/MCP.md §21, "Which clients" — the two published identities this server
// knows, as their client ID metadata documents (CIMD) served them. **Pinned,
// not fetched**: a request naming either URL is answered from the constant
// here, so the authorize path makes no outbound request and nobody can make
// the server fetch a URL of their choosing. The two are an allowlist: any
// other URL is an unknown client.
//
// The cost is that Anthropic can change a document. `scripts/check-oauth-clients.ts`
// fetches each and compares it with its pin (`documentDrift`, client-drift.ts),
// and `deploy/deploy.sh` runs it on every deploy; a change is then an edit
// here. Pure, with no database, so that script and the unit tests can load it.

/** The fields of a client ID metadata document that the pins carry. */
export type ClientMetadataDocument = {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: readonly string[];
  grant_types: readonly string[];
  response_types: readonly string[];
  token_endpoint_auth_method: string;
};

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

/** A pinned identity, and the `api_token.client` its connections get. */
export type PinnedClient = { document: ClientMetadataDocument; kind: "CLAUDE_AI" | "OTHER" };

export const PINNED_CLIENTS: readonly PinnedClient[] = [
  { document: CLAUDE_AI_METADATA, kind: "CLAUDE_AI" },
  { document: CLAUDE_CODE_METADATA, kind: "OTHER" },
];
