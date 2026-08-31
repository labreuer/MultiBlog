import { auth } from "@/lib/auth";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";

// PLAN.md §19 — the human-readable download URL, /files/<slug>/download.
//
// **A resolver, not a second way to serve bytes.** It answers a redirect to
// /api/files/<id>/<hash>, which stays the only route that reads from disk. The
// alternative — serving the bytes here — would mean either duplicating that
// route's range/ETag/streaming handling or weakening it, because a slug is
// *mutable*: it can be renamed, and FileSlugHistory then points an old one at
// the same file. The hash URL can answer `immutable` precisely because it
// cannot mean different bytes tomorrow, and nothing keyed on a slug can make
// that promise.
//
// Its access rules are /pdf/[slug]'s, not the byte route's, because it shares
// /pdf/[slug]'s key space: a visible "Forbidden" rather than the byte route's
// deliberate 404, since a slug that resolves at all is already disclosed by the
// reading view. The 404-for-forbidden there guards *id* guessing, which this
// route offers no way to do.
//
// No decodeURIComponent, matching /pdf/[slug]: slugify (src/lib/slug.ts)
// emits [a-z0-9-] only, so CLAUDE.md's percent-encoding gotcha has nothing to
// alter here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  const { slug } = await params;

  if (!session?.user) {
    // A URL meant to be pasted and clicked by a person, so it answers like a
    // page rather than like an API: sign in and come back, not a bare 401.
    return redirectTo("/sign-in");
  }

  const resolved = await resolveFileParam(slug, {
    id: true,
    sha256: true,
    visibility: true,
    deletedByUserId: true,
  });
  if (!resolved || resolved.file.deletedByUserId !== null) {
    return new Response("Not found", { status: 404 });
  }
  // `redirectTo` is ignored on purpose: it names /pdf/<current slug>, and the
  // canonical-URL contract it exists for is about *pages*, where landing at a
  // stale address quietly makes it the shared one. A download has no address to
  // keep — so a past slug goes straight to the bytes, one hop instead of two.
  if (!(await canUserReadFile(session.user.id, session.user.role, resolved.file))) {
    return new Response("Forbidden", { status: 403 });
  }

  // `download=1` is what makes this URL honest on its own: without it the byte
  // route answers a PDF `inline`, so pasting a /download URL into the address
  // bar would open the viewer instead of saving the file.
  return redirectTo(`/api/files/${resolved.file.id}/${resolved.file.sha256}?download=1`);
}

// A relative Location, which RFC 7231 allows: it leaves scheme and host exactly
// as the client sent them, so a reverse proxy in front of this (DEPLOY.md) has
// nothing to rewrite. `no-store` because the target moves whenever the file's
// bytes or slug do — it is the *target* that is immutable, never this.
function redirectTo(location: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "private, no-store" },
  });
}
