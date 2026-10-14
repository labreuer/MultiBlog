import { oauthMetadataResponse } from "@modelcontextprotocol/server";
import { metadataOptions } from "@/lib/oauth/discovery";

// docs/MCP.md §21, "Discovery" — the authorization server's metadata
// (RFC 8414), as src/lib/oauth/discovery.ts writes it, passed through by
// SDK v2 with CORS open. There is no OpenID configuration: nothing here
// issues an ID token, and a client needs only one of the two documents.
//
// OPTIONS is exported for the reason the resource's document gives.

export const dynamic = "force-dynamic";

function serve(request: Request): Response {
  return oauthMetadataResponse(request, metadataOptions()) ?? new Response(null, { status: 404 });
}

export const GET = serve;
export const OPTIONS = serve;
