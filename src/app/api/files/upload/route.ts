import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canManageFiles } from "@/lib/role-checks";
import { isAdmin } from "@/lib/authz";
import { claimFileSlug } from "@/lib/file-slug";
import {
  UploadError,
  deleteBytesIfUnreferenced,
  maxUploadBytes,
  storagePathFor,
  storeUploadStream,
} from "@/lib/file-storage";
import { extractPdf } from "@/lib/pdf-extract";
import { looksLikeDocx } from "@/lib/docx-validate";
import {
  UPLOAD_ACCEPT_LABEL,
  contentTypeForKind,
  titleFromFilename,
  uploadKindForFilename,
} from "@/lib/file-format";

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
  // Strip any directory component a browser or a scripted client might send.
  // Nothing downstream builds a path from this — the bytes go to a
  // content-addressed path derived from their own hash — so this is about the
  // *displayed* name being sane rather than about traversal, which the storage
  // layout already makes impossible.
  const filename = rawName.replace(/^.*[\\/]/, "").slice(0, 255);
  // Which format this claims to be decides which check runs on the stored
  // bytes below; an unrecognised extension never reaches storage at all.
  const kind = uploadKindForFilename(filename);
  if (!kind) {
    return NextResponse.json({ error: `Only ${UPLOAD_ACCEPT_LABEL} files can be uploaded.` }, { status: 415 });
  }
  const title = titleFromFilename(filename, kind);

  let stored;
  try {
    stored = await storeUploadStream(request.body);
  } catch (err) {
    if (err instanceof UploadError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[files/upload] storing the body failed:", err);
    return NextResponse.json({ error: "Couldn't save that file." }, { status: 500 });
  }

  // Check after storing, not before: the bytes are already safe on disk, so a
  // rejection is a clean rollback rather than a lost upload to retry.
  //
  // What "check" means depends on the format, and the difference is the point
  // (src/lib/docx-validate.ts). A PDF is fully parsed, because its page text is
  // what a later annotation anchors into — so a PDF we cannot read must not be
  // stored at all. A .docx is only confirmed to be a zip: nothing reads one
  // yet, so there is no anchor target to protect, and a deeper parse would only
  // reject documents we can hold perfectly well.
  //
  // The PDF branch is the one place a whole file is held in memory, and it is
  // deliberate. pdfjs needs the bytes; it is bounded by MAX_UPLOAD_BYTES, brief
  // (freed as soon as extraction returns), and one-per-upload rather than
  // one-per-read — exactly the distinction that ruled out a `bytea` column,
  // which would pay this on *every download*, forever.
  const discardStoredBytes = async () => {
    // Only remove the bytes if this upload is what put them there. A dedupe hit
    // means another file already references them and they must survive.
    if (!stored.deduped) {
      await deleteBytesIfUnreferenced(stored.sha256, 0);
    }
  };

  let pageCount: number | null = null;
  let pages: { textVersion: string; texts: readonly string[] } | null = null;

  if (kind === "pdf") {
    try {
      const parsed = await extractPdf(await readFile(storagePathFor(stored.sha256)));
      pageCount = parsed.pageCount;
      pages = { textVersion: parsed.textVersion, texts: parsed.pages };
    } catch (err) {
      console.error("[files/upload] couldn't parse the uploaded PDF:", err);
      await discardStoredBytes();
      return NextResponse.json({ error: "That PDF couldn't be read — it may be damaged." }, { status: 415 });
    }
  } else if (!(await looksLikeDocx(storagePathFor(stored.sha256)))) {
    await discardStoredBytes();
    return NextResponse.json({ error: "That doesn't look like a .docx file." }, { status: 415 });
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Claimed inside the transaction so two simultaneous uploads of
      // `report.pdf` become `report` and `report-2` rather than one of them
      // dying on the unique index (see claimFileSlug's own note).
      const slug = await claimFileSlug(tx, title);
      const file = await tx.storedFile.create({
        data: {
          slug,
          title,
          filename,
          contentType: contentTypeForKind(kind),
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          pageCount,
          updatedByUserId: session.user.id,
          // The uploader becomes the sole owner, the way createDoc makes its
          // creator the sole DocAuthor — "owner" rather than "author" because
          // nobody here wrote the PDF (schema.prisma's FileOwner). It is also
          // what makes the file visible to them at all under PRIVATE, which is
          // the default.
          owners: { create: { userId: session.user.id, ownerOrder: 0 } },
        },
        select: { id: true, slug: true, title: true },
      });
      // Only a parsed format has page text. A .docx stores none — which is
      // what the null pageCount above says as well.
      if (pages) {
        await tx.filePageText.createMany({
          data: pages.texts.map((text, pageIndex) => ({
            fileId: file.id,
            pageIndex,
            textVersion: pages.textVersion,
            text,
          })),
        });
      }
      return file;
    });

    return NextResponse.json({ id: created.id, slug: created.slug, title: created.title, sha256: stored.sha256 });
  } catch (err) {
    console.error("[files/upload] couldn't record the uploaded file:", err);
    if (!stored.deduped) {
      // Nothing references these bytes: the row that would have is what just
      // failed. Counted rather than assumed, because a concurrent upload of the
      // same PDF could have landed in between.
      const references = await prismaIncludingDeleted.storedFile.count({ where: { sha256: stored.sha256 } });
      await deleteBytesIfUnreferenced(stored.sha256, references);
    }
    return NextResponse.json({ error: "Couldn't save that file." }, { status: 500 });
  }
}
