import { readFile } from "node:fs/promises";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canManageFiles } from "@/lib/role-checks";
import { readableFilesWhere } from "@/lib/file-authz";
import { claimFileSlug } from "@/lib/file-slug";
import { UploadError, deleteBytesIfUnreferenced, storagePathFor, storeUploadStream, type StoredBytes } from "@/lib/file-storage";
import { extractPdf, extractPdfMetadata, type PdfMetadata } from "@/lib/pdf-extract";
import { UPLOAD_ACCEPT_LABEL, contentTypeForKind, titleFromFilename, uploadKindForFilename, type UploadKind } from "@/lib/file-format";
import type { Actor } from "@/lib/actor";

// PLAN.md §19, docs/MCP.md §8 — an upload, from bytes on the wire to a row
// with its owners and page text, for both front doors: /files' upload route
// (src/app/api/files/upload/route.ts) and the MCP server's
// (src/app/api/mcp/files/route.ts). Taking the actor rather than a bare user
// id keeps the role check inside the operation, where a front door can't
// leave it out. Every refusal is an UploadError carrying its HTTP status.
//
// Two steps, because the MCP route keys a repeat on the bytes' hash, which is
// known only once they are stored:
//
// 1. `stageUpload`: the role check, the filename and its format, and the
//    streamed write, hashed, its magic checked mid-flight — so a mislabelled
//    upload is refused after a few bytes rather than after the whole transfer.
// 2. `recordUpload`: a PDF's parse, then the row with its owners, page text,
//    labels and outline in one transaction — or, when asked, the file the
//    actor can already read that holds these bytes. A failure removes the
//    bytes if this upload is what put them there.

export type StagedUpload = { stored: StoredBytes; kind: UploadKind; filename: string };

export type RecordedUpload = {
  file: { id: string; slug: string; title: string };
  sha256: string;
  /** The bytes were already a file this actor can read, which is returned in place of a new one. */
  existing: boolean;
};

export async function stageUpload(actor: Actor, opts: { body: ReadableStream<Uint8Array>; filename: string }): Promise<StagedUpload> {
  if (!canManageFiles(actor.role)) throw new UploadError("Your account can't upload files.", 403);
  // Strip any directory component a browser or a scripted client might send.
  // Nothing downstream builds a path from this — the bytes go to a
  // content-addressed path derived from their own hash — so this is about the
  // *displayed* name being sane rather than about traversal.
  const filename = opts.filename.trim().replace(/^.*[\\/]/, "").slice(0, 255);
  if (!filename) throw new UploadError("Missing filename.", 400);
  // Which format this claims to be decides which check runs on the bytes; an
  // unrecognised extension never reaches storage at all.
  const kind = uploadKindForFilename(filename);
  if (!kind) throw new UploadError(`Only ${UPLOAD_ACCEPT_LABEL} files can be uploaded.`, 415);
  const stored = await storeUploadStream(opts.body, { kind });
  return { stored, kind, filename };
}

/** Removes staged bytes nothing references — counted, since a concurrent upload of the same bytes may have landed. */
export async function discardStagedUpload(staged: StagedUpload): Promise<void> {
  if (staged.stored.deduped) return;
  const references = await prismaIncludingDeleted.storedFile.count({ where: { sha256: staged.stored.sha256 } });
  await deleteBytesIfUnreferenced(staged.stored.sha256, references);
}

export async function recordUpload(
  actor: Actor,
  staged: StagedUpload,
  opts: {
    /** The title, by default the filename's (`titleFromFilename`). */
    title?: string;
    /** The owners, in order; by default the actor alone, as the uploader always was. */
    owners?: readonly string[];
    /** Return a live file the actor can read that already holds these bytes, rather than make another row. */
    reuseReadable?: boolean;
  } = {},
): Promise<RecordedUpload> {
  const { stored, kind, filename } = staged;

  if (opts.reuseReadable) {
    const readable = readableFilesWhere(actor.userId, actor.role);
    const existing = readable
      ? await prisma.storedFile.findFirst({
          where: { AND: [{ sha256: stored.sha256 }, readable] },
          orderBy: { createdAt: "asc" },
          select: { id: true, slug: true, title: true },
        })
      : null;
    if (existing) return { file: existing, sha256: stored.sha256, existing: true };
  }

  // A PDF is parsed after storing; a .docx is not, and that asymmetry is the
  // whole of the difference between them here. The bytes are already safe on
  // disk, so a parse failure is a clean rollback rather than a lost upload. A
  // PDF earns the parse because its page text is what a later annotation
  // anchors into — a PDF we cannot read must not be stored at all. A .docx has
  // no reader yet, so storeUploadStream's package check is its validation.
  //
  // The parse is the one place a whole file is held in memory, deliberately:
  // pdfjs needs the bytes, bounded by MAX_UPLOAD_BYTES, brief, and
  // one-per-upload rather than one-per-read.
  let pageCount: number | null = null;
  let pages: { textVersion: string; texts: readonly string[] } | null = null;
  let metadata: PdfMetadata | null = null;
  if (kind === "pdf") {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(storagePathFor(stored.sha256));
      const parsed = await extractPdf(bytes);
      pageCount = parsed.pageCount;
      pages = { textVersion: parsed.textVersion, texts: parsed.pages };
    } catch (err) {
      console.error("[files/upload] couldn't parse the uploaded PDF:", err);
      await discardStagedUpload(staged);
      throw new UploadError("That PDF couldn't be read — it may be damaged.", 415);
    }
    // Labels and the outline are stored now (docs/MCP.md §8); one that can't
    // be read is left NULL, which a first read fills lazily (pdf-metadata.ts).
    metadata = await extractPdfMetadata(bytes).catch((err) => {
      console.error("[files/upload] couldn't read the PDF's labels and outline:", err);
      return null;
    });
  }

  const title = opts.title?.trim().slice(0, 500) || titleFromFilename(filename, kind);
  const owners = opts.owners && opts.owners.length > 0 ? [...new Set(opts.owners)] : [actor.userId];
  try {
    const file = await prisma.$transaction(async (tx) => {
      // Claimed inside the transaction, under a lock on the slug, so two
      // simultaneous uploads of `report.pdf` become `report` and `report-2`
      // rather than one of them dying on the unique index (lockFileSlug).
      const slug = await claimFileSlug(tx, title);
      const created = await tx.storedFile.create({
        data: {
          slug,
          title,
          filename,
          contentType: contentTypeForKind(kind),
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          pageCount,
          ...(metadata
            ? { pageLabels: metadata.pageLabels as Prisma.InputJsonValue, outline: metadata.outline as unknown as Prisma.InputJsonValue }
            : {}),
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
          // "Owner" rather than "author" because nobody here wrote the PDF
          // (schema.prisma's FileOwner). It is also what makes the file
          // visible to them at all under PRIVATE, which is the default.
          owners: { create: owners.map((userId, ownerOrder) => ({ userId, ownerOrder })) },
        },
        select: { id: true, slug: true, title: true },
      });
      // Only a parsed format has page text. A .docx stores none — which is
      // what the null pageCount says as well.
      if (pages) {
        await tx.filePageText.createMany({
          data: pages.texts.map((text, pageIndex) => ({ fileId: created.id, pageIndex, textVersion: pages.textVersion, text })),
        });
      }
      return created;
    });
    return { file, sha256: stored.sha256, existing: false };
  } catch (err) {
    console.error("[files/upload] couldn't record the uploaded file:", err);
    await discardStagedUpload(staged);
    throw new UploadError("Couldn't save that file.", 500);
  }
}
