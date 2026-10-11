// docs/MCP.md §5 — what a request to /api/mcp answers when no token
// authenticated it.
//
// Never the session cookie: nothing under /api/mcp answers a browser.

/** What /api/mcp answers when nothing authenticated it. */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ code: "unauthorized", message: "A bearer token or a live grant is required." }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="multiblog"' },
  });
}
