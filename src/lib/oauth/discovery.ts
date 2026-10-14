import {
  getOAuthProtectedResourceMetadataUrl,
  type AuthMetadataOptions,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { appUrl } from "@/lib/app-url";

// docs/MCP.md §21, "Discovery" — what claude.ai reads before it opens the
// consent page: the endpoint's protected-resource metadata (RFC 9728), which
// names this origin as its authorization server, and that server's own
// metadata (RFC 8414). SDK v2 serves both through `oauthMetadataResponse`
// (src/app/.well-known/), from the options built here, and the 401 names the
// first (src/lib/mcp/bearer.ts).
//
// Read per request rather than at load: APP_URL is a runtime variable
// (docs/ENV.md). No document is built from the request's Host.

/** The scopes a connection can hold, by OAuth's names. Never `manage` (§3). */
export const OAUTH_SCOPES = ["read", "write"] as const;

/** How long an access token is good for, in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * APP_URL's origin, exactly, with no trailing slash. A client compares
 * issuers as strings and refuses the metadata on any difference, so the
 * resource's `authorization_servers`, the metadata's `issuer` and every
 * authorization response's `iss` are this one value.
 */
export function issuer(): string {
  return new URL(appUrl("")).origin;
}

/** The MCP endpoint's URL: the resource a connection is for, and its access tokens' audience. */
export function mcpEndpointUrl(): URL {
  return new URL("/api/mcp", issuer());
}

/** Where the endpoint's metadata is, as its 401 names it. */
export function resourceMetadataUrl(): string {
  return getOAuthProtectedResourceMetadataUrl(mcpEndpointUrl());
}

/**
 * The authorization server's metadata. The endpoints are `/authorize` and
 * `/token`, the 2025-03-26 revision's defaults for a client that finds no
 * metadata, so every path claude.ai might take leads to the same place.
 *
 * `none` as the only token-endpoint authentication, with CIMD supported, is
 * what makes claude.ai use its published identity rather than registering.
 * No `registration_endpoint`: there is no dynamic registration.
 *
 * `offline_access` is listed here and nowhere else, as the spec asks. A
 * client that sees it may add it to its request, which changes nothing: a
 * refresh token comes with every grant.
 */
export function authorizationServerMetadata(): OAuthMetadata {
  const origin = issuer();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...OAUTH_SCOPES, "offline_access"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** What v2 builds both documents from. */
export function metadataOptions(): AuthMetadataOptions {
  const oauthMetadata = authorizationServerMetadata();
  return {
    oauthMetadata,
    resourceServerUrl: mcpEndpointUrl(),
    scopesSupported: [...OAUTH_SCOPES],
    // v2 refuses an http: issuer other than localhost or 127.0.0.1. A dev
    // slot's b.localhost or c.localhost is neither, and no instance is http.
    dangerouslyAllowInsecureIssuerUrl: new URL(oauthMetadata.issuer).protocol === "http:",
  };
}
