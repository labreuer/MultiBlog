import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canManageFiles } from "@/lib/role-checks";
import { isAdmin } from "@/lib/authz";
import { UploadError, maxUploadBytes } from "@/lib/file-storage";
import { recordUpload, stageUpload } from "@/lib/file-ingest";
import { actorFromSessionUser } from "@/lib/actor";

// PLAN.md §19 — file upload.
//
// **A Route Handler, taking a raw body, on purpose.** Two separate limits are
// being avoided here, and it takes both decisions to avoid them:
//
//  1. *Route Handler, not Server Action.* Next applies `bodySizeLimit` (1MB by
//     default) to Server Actions and not to Route Handlers — see
//     uploadContributorAvatar (src/app/actions/contributor.ts), which documents
//     the constraint from the side that lives inside it. An avatar is tens of
//     KB after cropping and fits; a 50MB PDF never will, and raising the action
//     limit would raise it for *every* action on the site.
//  2. *Raw bytes, not multipart/form-data.* `await request.formData()` buffers
//     the entire upload in memory before user code sees any of it, which
//     reintroduces exactly the cost the disk-backed store exists to avoid. The
//     filename travels as a query parameter instead, and the body is nothing
//     but the file — which also means no multipart parser dependency.
//
// The client is XMLHttpRequest-based (src/components/FileUploader.tsx) rather
// than fetch-based, for upload progress and because a reverse proxy that cuts
// the connection mid-body is distinguishable there (`status === 0`) and opaque
// through fetch.

export const runtime = "nodejs";
// Nothing about this is cacheable and it reads the session; declared rather
// than inferred so a future Next default can't make it static and break it at
// build with DYNAMIC_SERVER_USAGE (PLAN.md §10 item 17).
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageFiles(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  }

  const url = new URL(request.url);

  // PLAN.md §19 — the deploy-time proxy check. Consumes and discards a body of
  // whatever size the client felt like sending, so an admin can confirm nginx
  // will actually pass MAX_UPLOAD_BYTES through *before* discovering otherwise
  // with someone's real 40MB PDF. ADMIN-only: it's an ops tool, and it lets a
  // caller burn bandwidth to no other end.
  if (url.searchParams.get("probe") === "1") {
    if (!isAdmin(session.user.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    let received = 0;
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
    }
    return NextResponse.json({ received, maxUploadBytes: maxUploadBytes() });
  }

  // Percent-decoded by hand: this is a query parameter rather than a dynamic
  // route segment, so CLAUDE.md's "params arrive re-encoded" gotcha does not
  // apply — URLSearchParams has already decoded it — but a filename genuinely
  // can contain characters that had to be encoded in transit.
  const rawName = url.searchParams.get("filename")?.trim();
  if (!rawName) {
    return NextResponse.json({ error: "Missing filename." }, { status: 400 });
  }

  // Everything from here is src/lib/file-ingest.ts's, which the MCP server's
  // upload route shares: the format check, the streamed write, a PDF's
  // parse, and the row with its owners and page text — the uploader the sole
  // owner, the way createDoc makes its creator the sole DocAuthor.
  try {
    const actor = actorFromSessionUser(session.user);
    const staged = await stageUpload(actor, { body: request.body, filename: rawName });
    const { file, sha256 } = await recordUpload(actor, staged);
    return NextResponse.json({ id: file.id, slug: file.slug, title: file.title, sha256 });
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[files/upload] storing the body failed:", err);
    return NextResponse.json({ error: "Couldn't save that file." }, { status: 500 });
  }
}
