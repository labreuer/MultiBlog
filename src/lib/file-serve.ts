import { Readable } from "node:stream";
import { prisma } from "@/lib/prisma";
import { canUserReadFile } from "@/lib/file-authz";
import { readStoredBytes, storedByteSize } from "@/lib/file-storage";
import type { Actor } from "@/lib/actor";

// PLAN.md §19 — serving an uploaded file's bytes, for whoever an actor is:
// the session's user at /api/files/<id>/<hash>, or a token's at the MCP
// server's byte route, /api/mcp/files/<id> (docs/MCP.md §5). One body, so the
// gate, the streaming, Range and the ETag can't differ between the two front
// doors. Server-only (node:stream).
//
// **Range support is the point of streaming from disk.** PDF.js issues range
// requests to render a large document's first page without transferring the
// whole file (docs/PDF.md's reason for the viewer being usable at all on a
// 50MB scan). Without `Accept-Ranges`/206 here, pdfjs silently falls back to
// fetching everything, and it is slow rather than broken — which is precisely
// the kind of regression nobody notices.

/**
 * The bytes of one version of `fileId` for `actor`, or 404 for a file that
 * doesn't exist or that the actor can't read — the same answer, since whether
 * a PRIVATE file exists is itself something its non-owners shouldn't learn,
 * and a route like this one is reachable by guessing an id.
 *
 * **Which version** (docs/PDF.md §13, "Addresses"):
 *
 * - `hash`, the content hash the URL carries: the bytes served are exactly
 *   those, when a version of the file that is not abandoned holds them, and
 *   the answer is `immutable`. Any other hash is 404, never the current
 *   bytes — so a viewer open on one version reads that version's bytes for as
 *   long as it is open, and can't splice another's in by range. `version`
 *   beside it names the download: that version's filename, once it is
 *   checked to hold the hash. Without it, the newest version holding the
 *   hash does, so the same bytes uploaded twice under two names each save
 *   under their own.
 * - no `hash`: the latest version's bytes, or with `version` that one's.
 */
export async function serveStoredFile(
  request: Request,
  actor: Actor,
  fileId: string,
  opts: { hash?: string; version?: number; forceAttachment?: boolean } = {},
): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  const row = await prisma.storedFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      visibility: true,
      currentVersionId: true,
      versions: {
        // An abandoned version keeps its row without its bytes.
        where: { abandonedAt: null },
        orderBy: { number: "desc" },
        select: { id: true, number: true, sha256: true, contentType: true, filename: true },
      },
    },
  });
  if (!row || !(await canUserReadFile(actor.userId, actor.role, row))) return notFound();

  const held = opts.hash === undefined ? row.versions : row.versions.filter((candidate) => candidate.sha256 === opts.hash);
  const version =
    opts.version !== undefined
      ? held.find((candidate) => candidate.number === opts.version)
      : opts.hash !== undefined
        ? held[0]
        : held.find((candidate) => candidate.id === row.currentVersionId);
  if (!version) return notFound();
  const file = { id: row.id, sha256: version.sha256, contentType: version.contentType, filename: version.filename };

  const etag = `"${file.sha256}"`;
  // `private`, never `public`: an intermediary caching this would serve one
  // reader's PRIVATE file to another. A URL naming the hash can never mean
  // other bytes; one that doesn't (the MCP route's) means "the latest".
  const cacheControl = opts.hash !== undefined
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

  const forceAttachment = opts.forceAttachment === true;

  const baseHeaders: Record<string, string> = {
    "Content-Type": file.contentType,
    ETag: etag,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    // inline for a PDF, so a click opens it in a viewer rather than downloading;
    // attachment for anything else, because a browser asked to render a .docx
    // inline either downloads it anyway or shows a page of binary, and the
    // second is worse than being asked where to save it — and attachment
    // whenever the caller asked for one outright, which is what /files/<slug>/download
    // does to keep the promise its name makes. Both forms of the filename
    // parameter: the ASCII fallback for old clients and the RFC 5987 encoded
    // one that survives non-ASCII names.
    "Content-Disposition": `${!forceAttachment && file.contentType === "application/pdf" ? "inline" : "attachment"}; filename="${file.filename.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
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
