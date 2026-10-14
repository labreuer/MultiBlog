import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { appUrl } from "@/lib/app-url";
import { authenticateSecret, type AuthenticatedToken } from "@/lib/api/tokens";
import { bearerGate } from "@/lib/mcp/bearer";
import { buildMcpServer } from "@/lib/mcp/server";

// docs/MCP.md §5 — the MCP endpoint: stateless Streamable HTTP, a fresh
// server per request, in this same Next process, each tool calling its
// operation in-process. One handler serves both protocol eras (§21, "Moving
// to SDK v2"): 2026-07-28's per-request envelope, and every 2025-era client
// through the SDK's stateless fallback.
//
// Bearer only, through SDK v2's bearer check (src/lib/mcp/bearer.ts), whose
// 401 is v2's challenge with OAuth's error object. The session cookie is
// never read, so there is no CSRF surface to defend, and nothing under
// /api/mcp answers a browser.
//
// JSON responses on the 2026-07-28 leg: a stateless server has nothing to
// push, and every call answers once. The 2025-era fallback answers with a
// one-event stream, which every client reads.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Made once for the process. `responseMode: "json"` makes the SDK warn, at
// this line, that mid-call notifications are dropped — so the warning prints
// in `next build` and at each start. It is expected: no tool sends any.
const handler = createMcpHandler((ctx) => buildMcpServer(tokenOf(ctx.authInfo)), {
  legacy: "stateless",
  responseMode: "json",
});

/** The token the bearer check passed, which `authInfo` carries to the factory. */
function tokenOf(authInfo: AuthInfo | undefined): AuthenticatedToken {
  const token = authInfo?.extra?.token as AuthenticatedToken | undefined;
  if (!token) throw new Error("The MCP handler ran without an authenticated token.");
  return token;
}

export async function POST(request: Request): Promise<Response> {
  // Read per request rather than at load: `APP_URL` is a runtime variable
  // (docs/ENV.md). A header token reports the endpoint it was sent to.
  const resource = new URL(appUrl("/api/mcp"));
  const authInfo = await bearerGate(request, resource, authenticateSecret);
  if (authInfo instanceof Response) return authInfo;
  return handler.fetch(request, { authInfo });
}

// No sessions, so nothing to stream on a GET or end on a DELETE (the
// transport's spec allows a stateless server to refuse both). Answered here
// rather than by the handler, whose 405 carries a JSON-RPC body and no Allow.
function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ code: "invalid", message: "This MCP server is stateless: POST only." }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
