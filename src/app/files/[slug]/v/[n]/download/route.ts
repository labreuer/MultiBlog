import { downloadRedirect } from "@/lib/file-download";
import { parseVersionNumber } from "@/lib/file-version";

// docs/PDF.md §13, "Addresses" — one version's download,
// /files/<slug>/v/<n>/download: saved under that version's own filename. A
// resolver like /files/<slug>/download, whose header has the reasons; the
// body is src/lib/file-download.ts's, shared with it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `_request` is unused but cannot be dropped: `params` is the second argument.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; n: string }> }) {
  const { slug, n } = await params;
  // Shape first, so a malformed number costs no query.
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) return new Response("Not found", { status: 404 });
  return downloadRedirect(slug, versionNumber);
}
