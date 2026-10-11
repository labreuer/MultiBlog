import { NextResponse } from "next/server";
import { authenticateByteRequest, unauthorizedResponse } from "@/lib/api/request-auth";
import { ApiError, httpStatusOf, invalid } from "@/lib/api/errors";
import type { AuthenticatedToken } from "@/lib/api/tokens";
import { exportCatalog, exportTar, selectByFilters, selectByList, type ExportFormat, type ExportSelection } from "@/lib/mcp/export";

// docs/MCP.md §5, §6 — the export: a tar of docs as files, or with `catalog=1`
// each doc's id, slug, title, size and newest version, as JSON. `GET` takes
// search's filters; `POST` a JSON list of doc URLs or ids. The `read` scope,
// through the bearer token or a grant from `download_url`.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/mcp/export";

function refuse(err: unknown): Response {
  if (err instanceof ApiError) return NextResponse.json(err.body(), { status: httpStatusOf(err) });
  console.error("[mcp/export] failed:", err);
  return NextResponse.json({ code: "internal", message: "The export failed." }, { status: 500 });
}

async function answer(request: Request, token: AuthenticatedToken, select: () => Promise<ExportSelection>): Promise<Response> {
  if (!token.scopes.includes("READ")) return NextResponse.json({ code: "forbidden", message: "This token can't read." }, { status: 403 });
  const url = new URL(request.url);
  try {
    const format = (url.searchParams.get("format") ?? "markdown") as ExportFormat;
    if (!["markdown", "text", "json"].includes(format)) throw invalid("format is markdown, text or json.");
    const selection = await select();
    console.log(JSON.stringify({ at: "mcp", token: token.prefix, user: token.user.id, tool: `${request.method} ${ROUTE}`, docs: selection.docIds.length }));
    if (url.searchParams.get("catalog") === "1") return NextResponse.json(await exportCatalog(selection));
    return new Response(exportTar(selection, format), {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": 'attachment; filename="multiblog-export.tar"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return refuse(err);
  }
}

export async function GET(request: Request) {
  const token = await authenticateByteRequest(request, ROUTE);
  if (!token) return unauthorizedResponse();
  const actor = { userId: token.user.id, role: token.user.role };
  return answer(request, token, () => selectByFilters(actor, new URL(request.url).searchParams));
}

export async function POST(request: Request) {
  const token = await authenticateByteRequest(request, ROUTE);
  if (!token) return unauthorizedResponse();
  const actor = { userId: token.user.id, role: token.user.role };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(invalid('POST a JSON body of the form {"docs": ["/doc/<slug>", "<id>", …]}.'));
  }
  return answer(request, token, () => selectByList(actor, (body as { docs?: unknown })?.docs));
}
