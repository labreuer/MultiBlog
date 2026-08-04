import { prisma } from "@/lib/prisma";

// Serves a self-hosted contributor avatar (PLAN.md §17n).
//
// **Public and unauthenticated, deliberately.** These render on `/`, which is
// a shared ISR-cached page that must never call auth() (§17a) — and the
// contributor list is public content by definition. Nothing here is gated,
// and nothing here reads the session, so this route stays cacheable by any
// intermediary.
//
// The whole point of this route over a base64 data URI is that the bytes get
// their own cache entry: inlining them would bake the image into `/`'s cached
// HTML, re-sent in full on every visit and never separately cacheable, and
// would rule out an ETag entirely. See CACHING.md's 2026-08-04 entry.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string; hash: string }> },
) {
  // No decodeURIComponent needed despite CLAUDE.md's percent-encoding gotcha:
  // a cuid and a hex hash contain nothing that survives encodeURIComponent
  // differently than it went in.
  const { userId, hash } = await params;

  const avatar = await prisma.userAvatar.findUnique({
    where: { userId },
    select: { bytes: true, contentType: true, hash: true },
  });
  if (!avatar) {
    return new Response("Not found", { status: 404 });
  }

  const etag = `"${avatar.hash}"`;
  if (request.headers.get("if-none-match") === etag) {
    // 304 carries no body; the validators still have to be repeated so the
    // browser can refresh its own freshness bookkeeping.
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cacheControl(true) } });
  }

  // A request whose path hash doesn't match what's stored is a *stale URL* —
  // most likely HTML that was cached before the avatar was replaced, which
  // `/`'s 60s ISR window makes a real (if brief) possibility rather than a
  // theoretical one. Serving the current bytes is the graceful answer: the
  // reader sees the right person's face rather than a broken image. What it
  // must not do is claim immutability for a URL whose content just moved, so
  // the stale path gets a revalidate-every-time header instead.
  const fresh = avatar.hash === hash;

  return new Response(new Uint8Array(avatar.bytes), {
    status: 200,
    headers: {
      "Content-Type": avatar.contentType,
      "Content-Length": String(avatar.bytes.byteLength),
      ETag: etag,
      "Cache-Control": cacheControl(fresh),
    },
  });
}

function cacheControl(fresh: boolean): string {
  return fresh ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
}
