import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserReadFile } from "@/lib/file-authz";
import { readStoredBytes, storedByteSize } from "@/lib/file-storage";

// PLAN.md §19 — serves an uploaded file's bytes.
//
// The URL shape (/api/files/<id>/<hash>/…) mirrors the avatar route's, and for
// the same reason: with the content hash in the path, the URL for a given set
// of bytes is immutable, which is what lets this answer `immutable` and use the
// hash as its ETag. Unlike the avatar route it is **session-gated** — an avatar
// is public content on a public page, a PDF is not — so `Cache-Control` is
// `private`, never `public`: an intermediary caching this would serve one
// reader's PRIVATE file to another.
//
// **Range support is the point of streaming from disk.** PDF.js issues range
// requests to render a large document's first page without transferring the
// whole file (docs/PDF.md's reason for the viewer being usable at all on a
// 50MB scan). Without `Accept-Ranges`/206 here, pdfjs silently falls back to
// fetching everything, and it is slow rather than broken — which is precisely
// the kind of regression nobody notices.

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

  const file = await prisma.storedFile.findUnique({
    where: { id },
    select: { id: true, visibility: true, sha256: true, byteSize: true, contentType: true, filename: true },
  });
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  if (!(await canUserReadFile(session.user.id, session.user.role, file))) {
    // 404 rather than 403: whether a PRIVATE file exists is itself something
    // its non-owners shouldn't learn, and this route is reachable by guessing
    // an id in a way /pdf/[slug] (which answers a visible Forbidden, matching
    // /doc/[slug]) is not.
    return new Response("Not found", { status: 404 });
  }

  const etag = `"${file.sha256}"`;
  const fresh = file.sha256 === hash;
  const cacheControl = fresh
    ? "private, max-age=31536000, immutable"
    : "private, max-age=0, must-revalidate";

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl } });
  }

  // Trust the file on disk over the recorded size: they agree unless something
  // has gone wrong outside this app, and a Content-Length that disagrees with
  // the body is worse than a slightly slower response.
  const size = await storedByteSize(file.sha256);
  if (size === null) {
    // The row exists and its bytes don't — a restored database without its
    // FILE_STORAGE_DIR, most likely (DEPLOY.md: two backup surfaces).
    console.error(`[files] ${file.id} references missing bytes ${file.sha256}`);
    return new Response("File contents are missing", { status: 503 });
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": file.contentType,
    ETag: etag,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    // inline, so a click opens the viewer rather than downloading. Both forms
    // of the filename parameter: the ASCII fallback for old clients and the
    // RFC 5987 encoded one that survives non-ASCII names.
    "Content-Disposition": `inline; filename="${file.filename.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  };

  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    return new Response(toWebStream(readStoredBytes(file.sha256, range)), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  return new Response(toWebStream(readStoredBytes(file.sha256)), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

// Only the single-range form (`bytes=a-b`, `bytes=a-`, `bytes=-n`) is honoured.
// Multi-range would need a multipart/byteranges body, and no PDF viewer asks
// for one — a request for several ranges is answered with the whole file
// instead, which is a legal response and correct, just less efficient.
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

// Node stream -> web stream. The cast is because `Readable.toWeb` is typed
// against node:stream/web's ReadableStream while `Response` wants the global
// one; they are the same object at runtime in Node 24.
function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}
