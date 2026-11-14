import { auth } from "@/lib/auth";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { filesPath } from "@/lib/file-version";
import { signInPath } from "@/lib/sign-in-redirect";

// PLAN.md §19, docs/PDF.md §13 "Addresses" — the resolver behind both
// download URLs, /files/<slug>/download (the latest version) and
// /files/<slug>/v/<n>/download (version n). Each route's own header says why
// it redirects to the byte route and doesn't serve bytes itself.
//
// **A version's download names its version to the byte route** (`&v=<n>`),
// which takes the download's filename from that version once it has checked
// that the version holds the hash. So two versions uploaded as `book.pdf`
// both save as `book.pdf`, and the same bytes uploaded twice under two names
// each save under their own. The bare download sends none: the newest version
// holding the latest's hash names it, which is the latest.

/** `versionNumber` is null for the bare address. */
export async function downloadRedirect(slug: string, versionNumber: number | null): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    // A URL meant to be pasted and clicked by a person, so it answers like a
    // page rather than like an API: sign in and come back, not a bare 401.
    //
    // Since this isn't actually a page, we don't want to redirect just-signed-in
    // users here. A landing page was made instead to handle that situation.
    return redirectTo(signInPath(filesPath(slug, versionNumber === null ? null : { number: versionNumber, isLatest: false })));
  }

  const resolved = await resolveFileParam(slug, {
    id: true,
    visibility: true,
    currentVersionId: true,
    versions: { select: { id: true, number: true, sha256: true, abandonedAt: true } },
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
  const { file } = resolved;
  const version = file.versions.find((candidate) => (versionNumber === null ? candidate.id === file.currentVersionId : candidate.number === versionNumber));
  // A number the file never had, or an abandoned version, which has no bytes.
  // After the gate, so it says nothing to someone who may not read the file.
  if (!version || version.abandonedAt !== null) {
    return new Response("Not found", { status: 404 });
  }

  // `download=1` is what makes this URL honest on its own: without it the byte
  // route answers a PDF `inline`, so pasting a /download URL into the address
  // bar would open the viewer instead of saving the file.
  return redirectTo(`/api/files/${file.id}/${version.sha256}?download=1${versionNumber === null ? "" : `&v=${version.number}`}`);
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
