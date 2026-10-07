import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { authenticateByteRequest, unauthorizedResponse } from "@/lib/api/request-auth";
import { ApiError, httpStatusOf, invalid } from "@/lib/api/errors";
import { onceWithin } from "@/lib/api/idempotency";
import { MAX_MARKDOWN_BYTES } from "@/lib/markdown-import";
import { createDocFor } from "@/lib/mcp/doc-writes";

// docs/MCP.md §5 — a doc from a Markdown request body
// (`curl --data-binary @summary.md`), so a draft refined in a local file isn't
// typed out a second time through the model. It is create_doc's operation —
// PRIVATE, the byline's choice included — with the `write` scope, through a
// grant from `upload_url` or the bearer token. The title is `?title=`, or the
// file's leading heading as the importer takes it; `?issuerOnly=1` leaves the
// actor off the byline.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/mcp/docs";

export async function POST(request: Request) {
  const token = await authenticateByteRequest(request, ROUTE);
  if (!token) return unauthorizedResponse();
  const ctx = { token, actor: { userId: token.user.id, role: token.user.role } };
  try {
    if (!token.scopes.includes("WRITE")) throw new ApiError("forbidden", "This token can't write.");
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_MARKDOWN_BYTES) {
      throw new ApiError("too_large", `That's ${Math.round(body.length / 1024)} KB of Markdown; the limit is ${MAX_MARKDOWN_BYTES / 1024} KB.`);
    }
    const markdown = new TextDecoder("utf-8", { fatal: false }).decode(body);
    if (!markdown.trim()) throw invalid("The body is empty: send the Markdown as the request body.");
    const title = url.searchParams.get("title") ?? undefined;
    const issuerOnly = url.searchParams.get("issuerOnly") === "1";
    // An upload keys on its bytes' hash and its parameters (§4).
    const keyArgs = { sha256: createHash("sha256").update(body).digest("hex"), title, issuerOnly };
    const result = await onceWithin(token.id, `POST ${ROUTE}`, keyArgs, url.searchParams.get("idempotencyKey") ?? undefined, () =>
      createDocFor(ctx, { markdown, title, issuerOnly }),
    );
    console.log(JSON.stringify({ at: "mcp", token: token.prefix, user: token.user.id, tool: `POST ${ROUTE}`, outcome: "ok" }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json(err.body(), { status: httpStatusOf(err) });
    console.error("[mcp/docs] failed:", err);
    return NextResponse.json({ code: "internal", message: "Creating the doc failed." }, { status: 500 });
  }
}
