import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { UploadError } from "@/lib/file-storage";
import { assertMayUploadVersion, discardRefusedBody, recordVersionUpload, stageUpload } from "@/lib/file-ingest";
import { actorFromSessionUser } from "@/lib/actor";

// docs/PDF.md §13, "The upload" — a new version of a file:
// `PUT /api/files/<id>?filename=…`, the new bytes as the raw body.
//
// A Route Handler taking a raw body, for the upload's own two reasons
// (../upload/route.ts): a Server Action's body limit, and `formData()`
// buffering the whole upload.
//
// **The file's own checks come before the body is stored**
// (`assertMayUploadVersion`): whoever uploads may manage the file, it is a
// live PDF, and no candidate stands. `stageUpload` checks only the uploader's
// role, so without them a body of any size would be written to disk and
// parsed for a file its sender may not touch.
//
// **A body refused before anything read it is received and dropped**
// (`discardRefusedBody`), never left unread: a response sent over an unread
// request closes the connection under it, and the uploader would see a
// severed connection where "this file already has a version waiting" should
// be.
//
// It answers the candidate's number and address, or `unchanged` for bytes the
// latest version already holds. Everything from the checks on is
// src/lib/file-ingest.ts's, which the MCP server's route shares.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "No file was sent." }, { status: 400 });
  }
  // A cuid holds nothing `encodeURIComponent` alters, so the param needs no decoding.
  const { id } = await params;
  const filename = new URL(request.url).searchParams.get("filename")?.trim();
  if (!filename) {
    return NextResponse.json({ error: "Missing filename." }, { status: 400 });
  }

  try {
    const actor = actorFromSessionUser(session.user);
    await assertMayUploadVersion(actor, id);
    const staged = await stageUpload(actor, { body: request.body, filename });
    const recorded = await recordVersionUpload(actor, id, staged);
    if (recorded.unchanged) {
      return NextResponse.json({ id: recorded.file.id, slug: recorded.file.slug, unchanged: true });
    }
    return NextResponse.json(
      { id: recorded.file.id, slug: recorded.file.slug, version: recorded.version.number, versionId: recorded.version.id, url: recorded.url },
      { status: 201 },
    );
  } catch (err) {
    await discardRefusedBody(request.body);
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[files/version] storing the body failed:", err);
    return NextResponse.json({ error: "Couldn't save that version." }, { status: 500 });
  }
}
