import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { prisma, prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { canManageFiles } from "@/lib/role-checks";
import { canUserReadFile, canUserUploadFileVersion, readableFilesWhere } from "@/lib/file-authz";
import { claimFileSlug } from "@/lib/file-slug";
import { pdfPath } from "@/lib/file-version";
import { createFileWithFirstVersion, lockFileHash, lockFileRow } from "@/lib/file-version-data";
import { UploadError, deleteBytesIfUnreferenced, maxUploadBytes, storagePathFor, storedByteSize, storeUploadStream, type StoredBytes } from "@/lib/file-storage";
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
// 2. `recordUpload`: a PDF's parse, then the file with its owners and its
//    version 1, which holds what the bytes decide, with its page text, in
//    one transaction — or, when asked, the file the actor can already read
//    whose latest version holds these bytes. A failure removes the bytes if
//    this upload is what put them there.
//
// **A new version of a file** (docs/PDF.md §13, "The upload") is the same two
// steps around the file's own checks: `assertMayUploadVersion` before the
// body is read, since `stageUpload` checks only the uploader's role, then
// `stageUpload`, then `recordVersionUpload`, which makes the file's next
// version, a candidate, with its page text.
//
// **Every row that holds a hash is inserted under a lock on that hash**
// (`lockFileHash`), with the blob checked to be on disk there, and every
// removal of a blob is made under the same lock. `storeUploadStream` decides
// whether the bytes were already stored with no database, seconds before the
// row is written, so the lock can't be held from that decision: an upload
// whose blob is gone by the time its row is written is refused, to be sent
// again.

export type StagedUpload = { stored: StoredBytes; kind: UploadKind; filename: string };

/**
 * Receives and drops a request body that was refused before anything read
 * it, so the refusal reaches its sender.
 *
 * A response sent while the body is still arriving leaves the server with an
 * unread request, and it closes the connection under the response: the
 * sender gets a reset where the refusal's message should be (`ECONNRESET`
 * from a script, a severed connection in a browser, which the uploader then
 * blames on a proxy). Nothing is stored and nothing is parsed, so a refusal
 * still costs no disk; what it costs is the transfer, bounded by the upload
 * limit, past which the rest is cancelled.
 *
 * A no-op for a body something has begun to read: `storeUploadStream` cancels
 * its own on a refusal mid-stream.
 */
export async function discardRefusedBody(body: ReadableStream<Uint8Array> | null, maxBytes = maxUploadBytes()): Promise<void> {
  if (!body || body.locked) return;
  const reader = body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      received += value?.byteLength ?? 0;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } catch {
    // The sender went away, which is their answer.
  }
}

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

/**
 * Removes staged bytes nothing references. Counted, since a concurrent upload
 * of the same bytes may have landed, and **counted and removed under the
 * lock on the hash**, so an upload of the same bytes can't write its row
 * between the count and the removal.
 */
export async function discardStagedUpload(staged: StagedUpload): Promise<void> {
  if (staged.stored.deduped) return;
  const { sha256 } = staged.stored;
  // `file_version` has no soft deletion, so the count is every row holding the hash, a deleted file's included.
  await prisma.$transaction(async (tx) => {
    await lockFileHash(tx, sha256);
    await deleteBytesIfUnreferenced(sha256, await tx.fileVersion.count({ where: { sha256, abandonedAt: null } }));
  });
}

/**
 * Checks, **under the lock on the hash and inside the transaction that
 * inserts the row**, that the bytes a row is about to name are on disk. They
 * were when the upload was staged; an abandoning or a discarded upload of the
 * same bytes may have removed them since.
 */
async function assertBlobStored(tx: TransactionClient, sha256: string): Promise<void> {
  await lockFileHash(tx, sha256);
  if ((await storedByteSize(sha256)) === null) throw blobGone();
}

/** What an upload is told when its staged bytes are no longer on disk: nothing is wrong with the file, and sending it again stores it anew. */
function blobGone(): UploadError {
  return new UploadError("Those bytes were removed while this upload was being recorded. Send the file again.", 409);
}

/**
 * The staged bytes, for the parse. Gone already where an abandoning or a
 * discarded upload of the same bytes removed them since they were staged,
 * which is refused as `assertBlobStored` refuses it, and never as a damaged
 * PDF.
 */
async function readStaged(sha256: string): Promise<Uint8Array> {
  try {
    return await readFile(storagePathFor(sha256));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw blobGone();
    throw err;
  }
}

export async function recordUpload(
  actor: Actor,
  staged: StagedUpload,
  opts: {
    /** The title, by default the filename's (`titleFromFilename`). */
    title?: string;
    /** The owners, in order; by default the actor alone, as the uploader always was. */
    owners?: readonly string[];
    /**
     * Return a live file the actor can read whose latest version already holds
     * these bytes, rather than make another row. Bytes only an earlier version
     * holds make a new file, since the file found would show other bytes.
     */
    reuseReadable?: boolean;
  } = {},
): Promise<RecordedUpload> {
  const { stored, kind, filename } = staged;

  if (opts.reuseReadable) {
    const readable = readableFilesWhere(actor.userId, actor.role);
    const existing = readable
      ? await prisma.storedFile.findFirst({
          where: { AND: [{ currentVersion: { sha256: stored.sha256 } }, readable] },
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
      bytes = await readStaged(stored.sha256);
      const parsed = await extractPdf(bytes);
      pageCount = parsed.pageCount;
      pages = { textVersion: parsed.textVersion, texts: parsed.pages };
    } catch (err) {
      await discardStagedUpload(staged);
      if (err instanceof UploadError) throw err;
      console.error("[files/upload] couldn't parse the uploaded PDF:", err);
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
      await assertBlobStored(tx, stored.sha256);
      const made = await createFileWithFirstVersion(tx, {
        slug,
        title,
        uploaderId: actor.userId,
        ownerIds: owners,
        bytes: { filename, contentType: contentTypeForKind(kind), byteSize: stored.byteSize, sha256: stored.sha256, pageCount, metadata, pages },
      });
      return { id: made.id, slug: made.slug, title: made.title };
    });
    return { file, sha256: stored.sha256, existing: false };
  } catch (err) {
    await discardStagedUpload(staged);
    if (err instanceof UploadError) throw err;
    console.error("[files/upload] couldn't record the uploaded file:", err);
    throw new UploadError("Couldn't save that file.", 500);
  }
}

// ---------------------------------------------------------------------------
// docs/PDF.md §13, "The upload" — a new version of a file.

/** The file a version is being uploaded to, as its checks found it. */
export type VersionUploadTarget = { id: string; slug: string; title: string };

/** What a version's upload came to: a candidate, or nothing, for bytes the latest version already holds. */
export type RecordedVersion =
  | { file: VersionUploadTarget; unchanged: true }
  | { file: VersionUploadTarget; unchanged: false; version: { id: string; number: number }; /** The candidate's own address. */ url: string };

/** What a standing candidate's refusal says, in either front door. */
function candidateStands(file: { slug: string }, number: number): UploadError {
  return new UploadError(
    `This file already has a version waiting, version ${number}, at ${pdfPath(file.slug, { number, isLatest: false })}. Promote it or abandon it before uploading another.`,
    409,
  );
}

/**
 * The file's own checks, **before the body is stored**: `stageUpload` checks
 * only the uploader's role, so without these a 50MB body would be written to
 * disk and parsed for a file its sender may not touch. A route that refuses
 * here receives the body and drops it (`discardRefusedBody`), so the refusal
 * arrives.
 *
 * - whoever uploads may manage the file, or is a bot whose person may
 *   (`canUserUploadFileVersion`). A file the actor can't even read is
 *   answered as one that doesn't exist;
 * - the file is not deleted, and is a PDF: nothing else has sheets to give a
 *   new copy of;
 * - no candidate stands. `allowCandidate` leaves that to
 *   `recordVersionUpload`, for the MCP route, whose retry of an upload must
 *   reach its idempotency key to be answered with the candidate the first
 *   request made, and the key is the bytes' hash.
 */
export async function assertMayUploadVersion(actor: Actor, fileId: string, opts: { allowCandidate?: boolean } = {}): Promise<VersionUploadTarget> {
  const file = await prismaIncludingDeleted.storedFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      slug: true,
      title: true,
      visibility: true,
      deletedByUserId: true,
      currentVersion: { select: { pageCount: true } },
      versions: { where: { promotedAt: null, abandonedAt: null }, select: { number: true } },
    },
  });
  const mayUpload = file ? await canUserUploadFileVersion(actor.userId, actor.role, file.id) : false;
  if (!file || (!mayUpload && !(await canUserReadFile(actor.userId, actor.role, file)))) {
    throw new UploadError("That file doesn't exist, or isn't yours to read.", 404);
  }
  if (!mayUpload) throw new UploadError("You can read this file but not manage it, so you can't give it a new version.", 403);
  if (file.deletedByUserId !== null) throw new UploadError("This file is deleted, and takes no new version until it is restored.", 409);
  if (!file.currentVersion || file.currentVersion.pageCount === null) throw new UploadError("Only a PDF takes a new version.", 415);
  if (!opts.allowCandidate && file.versions.length > 0) throw candidateStands(file, file.versions[0].number);
  return { id: file.id, slug: file.slug, title: file.title };
}

/**
 * Makes the staged bytes the file's next version, a **candidate**: readable
 * at once at its own address, and nothing else changes until someone
 * promotes it. It builds no page map and promotes nothing (docs/PDF.md §13,
 * "The upload").
 *
 * - Bytes identical to the latest version's answer `unchanged` and write
 *   nothing. Bytes identical to an earlier version's, or to another file's,
 *   make a version as any others do, sharing the blob.
 * - The checks `assertMayUploadVersion` made are made again here, under the
 *   file row's lock: the file may have been deleted, another candidate
 *   uploaded, or a version promoted, while the body arrived.
 * - The version's number is one more than the file's rows, an abandoned
 *   one's included, so a number is never reused.
 *
 * A failure removes the bytes if this upload is what put them there.
 */
export async function recordVersionUpload(actor: Actor, fileId: string, staged: StagedUpload): Promise<RecordedVersion> {
  const { stored, kind, filename } = staged;
  const refuse = async (error: UploadError): Promise<never> => {
    await discardStagedUpload(staged);
    throw error;
  };
  if (kind !== "pdf") return refuse(new UploadError("A new version of a PDF is a PDF.", 415));
  let target: VersionUploadTarget;
  try {
    target = await assertMayUploadVersion(actor, fileId, { allowCandidate: true });
  } catch (err) {
    return refuse(err instanceof UploadError ? err : new UploadError("Couldn't save that version.", 500));
  }

  let parsed: Awaited<ReturnType<typeof extractPdf>>;
  let metadata: PdfMetadata | null;
  try {
    const bytes = await readStaged(stored.sha256);
    parsed = await extractPdf(bytes);
    // As for a first upload: labels and an outline that can't be read are left NULL, and a first read fills them.
    metadata = await extractPdfMetadata(bytes).catch((err) => {
      console.error("[files/upload] couldn't read the new version's labels and outline:", err);
      return null;
    });
  } catch (err) {
    if (err instanceof UploadError) return refuse(err);
    console.error("[files/upload] couldn't parse the uploaded version:", err);
    return refuse(new UploadError("That PDF couldn't be read — it may be damaged.", 415));
  }

  try {
    return await prisma.$transaction(async (tx): Promise<RecordedVersion> => {
      const file = await lockFileRow(tx, fileId);
      if (!file) throw new UploadError("That file doesn't exist, or isn't yours to read.", 404);
      if (file.deleted) throw new UploadError("This file is deleted, and takes no new version until it is restored.", 409);
      const versions = await tx.fileVersion.findMany({ where: { fileId }, select: { id: true, number: true, sha256: true, promotedAt: true, abandonedAt: true } });
      const latest = versions.find((version) => version.id === file.currentVersionId);
      // Bytes the latest already holds: nothing to do, and nothing is written.
      if (latest?.sha256 === stored.sha256) return { file: target, unchanged: true };
      const standing = versions.find((version) => version.promotedAt === null && version.abandonedAt === null);
      if (standing) throw candidateStands(target, standing.number);

      await assertBlobStored(tx, stored.sha256);
      const tail = await tx.ydocUpdate.aggregate({ _max: { id: true } });
      const version = await tx.fileVersion.create({
        data: {
          fileId,
          // Never reused: one more than the file's rows, an abandoned one's included.
          number: versions.length + 1,
          filename,
          contentType: contentTypeForKind(kind),
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          pageCount: parsed.pageCount,
          ...(metadata ? { pageLabels: metadata.pageLabels as Prisma.InputJsonValue, outline: metadata.outline as unknown as Prisma.InputJsonValue } : {}),
          uploadedByUserId: actor.userId,
          // The version that was the latest at this upload: it can't be worked out from the numbers once one between is abandoned.
          baseVersionId: file.currentVersionId,
          uploadedAtUpdateId: tail._max.id ?? BigInt(0),
        },
        select: { id: true, number: true },
      });
      await tx.filePageText.createMany({
        data: parsed.pages.map((text, pageIndex) => ({ fileVersionId: version.id, pageIndex, textVersion: parsed.textVersion, text })),
      });
      return { file: target, unchanged: false, version, url: pdfPath(target.slug, { number: version.number, isLatest: false }) };
    });
  } catch (err) {
    if (err instanceof UploadError) return refuse(err);
    // The one-candidate index, where two uploads got past each other's lock on different rows of nothing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return refuse(new UploadError("Another version of this file was uploaded at the same moment. Look at the file's versions before sending this one again.", 409));
    }
    console.error("[files/upload] couldn't record the uploaded version:", err);
    return refuse(new UploadError("Couldn't save that version.", 500));
  }
}
