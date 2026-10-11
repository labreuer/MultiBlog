import { authenticateByteRequest, unauthorizedResponse } from "@/lib/api/request-auth";
import { serveStoredFile } from "@/lib/file-serve";

// docs/MCP.md §5 — a file's bytes for a token, or a grant `download_url`
// minted from one, with the `read` scope. The body is the session route's
// (src/lib/file-serve.ts): its gate, which answers 404 for a file the reader
// can't see, and its streaming, Range and ETag.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await authenticateByteRequest(request, `/api/mcp/files/${id}`);
  if (!token) return unauthorizedResponse();
  if (!token.scopes.includes("READ")) return new Response("This token can't read.", { status: 403 });
  return serveStoredFile(request, { userId: token.user.id, role: token.user.role }, id, { forceAttachment: true });
}
