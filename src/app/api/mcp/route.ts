import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateSecret, bearerSecret } from "@/lib/api/tokens";
import { unauthorizedResponse } from "@/lib/api/request-auth";
import { buildMcpServer } from "@/lib/mcp/server";

// docs/MCP.md §5 — the MCP endpoint: stateless Streamable HTTP, a fresh
// server and transport per request, in this same Next process, each tool
// calling its operation in-process.
//
// Bearer only. The session cookie is never read, so there is no CSRF surface
// to defend, and nothing under /api/mcp answers a browser.
//
// JSON responses rather than an SSE stream: a stateless server has nothing to
// push, and every call answers once.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = bearerSecret(request);
  const token = secret ? await authenticateSecret(secret) : null;
  if (!token) return unauthorizedResponse();

  const server = buildMcpServer(token);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

// No sessions, so nothing to stream on a GET or end on a DELETE (the
// transport's spec allows a stateless server to refuse both).
function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ code: "invalid", message: "This MCP server is stateless: POST only." }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
