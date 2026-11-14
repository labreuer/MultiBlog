import { downloadRedirect } from "@/lib/file-download";

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

// `_request` is unused but cannot be dropped: `params` is the second argument.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return downloadRedirect(slug, null);
}
