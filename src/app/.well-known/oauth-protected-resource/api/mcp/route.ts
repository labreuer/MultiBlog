import { oauthMetadataResponse } from "@modelcontextprotocol/server";
import { metadataOptions } from "@/lib/oauth/discovery";

// docs/MCP.md §21, "Discovery" — /api/mcp's protected-resource metadata
// (RFC 9728), where its 401 points: the endpoint as `resource`, this origin as
// its authorization server, and the scopes. Served at the endpoint's own path
// and nowhere else, so not at the root: a document there would describe the
// origin rather than an endpoint, and every client reads the 401 first.
//
// SDK v2 builds and answers it, CORS open. OPTIONS is exported too: Next
// answers a preflight to a route without one itself, with no CORS headers,
// and a browser client sending a header of its own could never read this.

export const dynamic = "force-dynamic";

function serve(request: Request): Response {
  return oauthMetadataResponse(request, metadataOptions()) ?? new Response(null, { status: 404 });
}

export const GET = serve;
export const OPTIONS = serve;
