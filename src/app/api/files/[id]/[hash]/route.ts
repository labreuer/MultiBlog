import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { serveStoredFile } from "@/lib/file-serve";

// PLAN.md §19 — serves an uploaded file's bytes to the signed-in reader.
//
// The URL shape (/api/files/<id>/<hash>/…) mirrors the avatar route's, and for
// the same reason: with the content hash in the path, the URL for a given set
// of bytes is immutable, which is what lets this answer `immutable` and use the
// hash as its ETag. Unlike the avatar route it is **session-gated** — an avatar
// is public content on a public page, a PDF is not. The body — the gate,
// streaming, Range and the ETag — is src/lib/file-serve.ts's, shared with the
// MCP server's byte route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; hash: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // No decodeURIComponent needed despite CLAUDE.md's percent-encoding gotcha: a
  // cuid and a hex hash contain nothing encodeURIComponent alters.
  const { id, hash } = await params;

  // `?download=1` forces the attachment form, which is how /files/<slug>/download
  // (a URL whose whole promise is that it saves the file) gets that promise out
  // of a route that would otherwise answer a PDF `inline`.
  const forceAttachment = new URL(request.url).searchParams.get("download") === "1";
  return serveStoredFile(request, actorFromSessionUser(session.user), id, { hash, forceAttachment });
}
