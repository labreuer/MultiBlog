import { after } from "next/server";
import { pruneSpent, tokenGrant, type TokenAnswer } from "@/lib/oauth/grant";

// docs/MCP.md §21, "The token endpoint" — `POST /token`, a form-encoded body
// answered with JSON and `Cache-Control: no-store`. The logic is
// src/lib/oauth/grant.ts. At the root rather than under /api/, at the path the
// spec's 2025-03-26 revision gave as the default, so a client that finds no
// metadata still lands here; a static route, so /[year] never sees it.
//
// **CORS is open, without credentials**, for a browser client such as the
// MCP Inspector; nothing here reads a cookie. OPTIONS answers the preflight a
// form post with a header of its own needs.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Far above any real token request, whose fields are a code, a verifier and a few URLs. */
const MAX_BODY_CHARS = 16 * 1024;

const CORS = { "Access-Control-Allow-Origin": "*" };

function answer({ status, body }: TokenAnswer): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...CORS } });
}

function invalidRequest(description: string): Response {
  return answer({ status: 400, body: { error: "invalid_request", error_description: description } });
}

export async function POST(request: Request): Promise<Response> {
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return invalidRequest("The body must be application/x-www-form-urlencoded.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return invalidRequest("The body is too large.");
  let result: TokenAnswer;
  try {
    result = await tokenGrant(new URLSearchParams(text));
  } catch (err) {
    console.error("[oauth] the token endpoint failed:", err);
    result = { status: 500, body: { error: "server_error", error_description: "Something went wrong on the server." } };
  }
  // After the answer, never before it: claude.ai gives /token 10 seconds.
  after(() => pruneSpent().catch((err) => console.error("[oauth] pruning failed:", err)));
  return answer(result);
}

export function OPTIONS(request: Request): Response {
  const requested = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...(requested ? { "Access-Control-Allow-Headers": requested, Vary: "Access-Control-Request-Headers" } : {}),
    },
  });
}
