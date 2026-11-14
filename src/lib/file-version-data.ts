import { Prisma } from "@/generated/prisma/client";
import type { DocVisibility } from "@/generated/prisma/enums";
import { prisma, prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { displayNameOf } from "@/lib/display-name";
import { CAPTURE_RELOAD_MESSAGE, fileVersionState, type CaptureOrigin, type FileVersionState } from "@/lib/file-version";

// docs/PDF.md §13, "Versions" — the queries over `file_version` that more
// than one module asks. Server-only (Prisma); the vocabulary they share with
// the browser is `file-version.ts`.

/**
 * The id of a file's latest version: what a caller holding only a file's id
 * passes wherever a version's id is taken (page text, labels, the outline).
 *
 * Throws on a file that doesn't exist or has no latest version, which is a
 * fault and never a state a reader handles (`latestVersionOf`). A
 * soft-deleted file still has its versions, so this reads past the filter.
 */
export async function latestVersionIdOf(fileId: string): Promise<string> {
  const file = await prismaIncludingDeleted.storedFile.findUnique({ where: { id: fileId }, select: { currentVersionId: true } });
  if (!file?.currentVersionId) {
    throw new Error(`File ${fileId} has no latest version (docs/PDF.md §13, "Versions").`);
  }
  return file.currentVersionId;
}

/**
 * How many versions hold these bytes: every `file_version` row with the hash
 * that is not abandoned, a soft-deleted file's included. An abandoned version
 * keeps its row and its hash without its bytes, so it holds none.
 */
export function countVersionsHolding(sha256: string): Promise<number> {
  return prismaIncludingDeleted.fileVersion.count({ where: { sha256, abandonedAt: null } });
}

// The first key of the two-key advisory lock below, so these locks occupy a
// space of their own: "blob" as four ASCII bytes. A slug's claim has its own
// (`lockFileSlug`, src/lib/file-slug.ts).
const FILE_HASH_LOCK_SPACE = 0x626c6f62;

/**
 * Holds a blob's hash for the rest of `tx` (docs/PDF.md §13, "The upload"):
 * an advisory lock, held to the end of the transaction, as a slug's claim is.
 * **Whatever writes a row holding a hash, and whatever removes a hash's
 * bytes, takes it**, so the two can't cross:
 *
 * - an upload, of a file's first version or a later one, in the transaction
 *   that inserts its row, where it then checks the blob is still on disk
 *   (`assertBlobStored`);
 * - abandoning a candidate, around its count of the other rows holding the
 *   hash and its removal of the blob, which it does before it commits;
 * - `discardStagedUpload`, around the same count and removal.
 *
 * Without it, bytes uploaded again beside the abandoning of the candidate
 * that held them leave a row with no bytes: `storeUploadStream` finds the
 * blob on disk and stores nothing, and its row is written seconds later,
 * after the abandoning counted no other row and removed the blob. Nothing
 * reports that until the integrity check runs.
 *
 * A file row is locked before a hash where a transaction takes both, so no
 * two of them can wait on each other.
 */
export async function lockFileHash(tx: TransactionClient, sha256: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FILE_HASH_LOCK_SPACE}::int4, hashtext(${sha256}))`;
}

/**
 * Locks a file's row `FOR UPDATE` for the rest of `tx`, and answers what a
 * version's write checks under it: which version is the latest, and whether
 * the file is deleted. Null for no such file.
 *
 * The upload of a version, a promotion and an abandoning each take it, so
 * two of them on one file run one after the other: a version's number is one
 * more than the file's rows, and "still the candidate" is true for only one
 * of two clicks. It conflicts with the `FOR SHARE` a capture takes
 * (`assertCaptureVersion`), which is what makes a promotion wait for a
 * capture in flight.
 */
export async function lockFileRow(tx: TransactionClient, fileId: string): Promise<{ currentVersionId: string | null; deleted: boolean } | null> {
  const [row] = await tx.$queryRaw<{ currentVersionId: string | null; deleted: boolean }[]>(
    Prisma.sql`SELECT "current_version_id" AS "currentVersionId", ("deleted_by_user_id" IS NOT NULL) AS "deleted" FROM "file" WHERE "id" = ${fileId} FOR UPDATE`,
  );
  return row ?? null;
}

/** What a version's bytes decide, as a parse of them reports it. */
export type VersionBytes = {
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  /** Null for a format with no page text (a .docx). */
  pageCount: number | null;
  /** Labels and the outline, where the parse read them; a first read fills them otherwise (pdf-metadata.ts). */
  metadata?: { pageLabels: unknown; outline: unknown } | null;
  /** The page text extracted with the parse, or null for a format that has none. */
  pages: { textVersion: string; texts: readonly string[] } | null;
};

/**
 * A file with its version 1, for the upload and for every script and fixture
 * that makes a file as the upload does. Must run inside a transaction.
 *
 * **The two rows name each other, so they are written in a fixed order**: the
 * file with no latest version, the version, then the pointer (docs/PDF.md
 * §13, "Versions"). The order is the search trigger's as well: it reads the
 * filename through the pointer, so the update that sets it is what puts the
 * filename in the file's vector.
 *
 * Version 1 is made promoted, by its uploader at its upload, so it is never a
 * candidate. Both its update ids come from one read of the log's tail.
 */
export async function createFileWithFirstVersion(
  tx: TransactionClient,
  opts: {
    slug: string;
    title: string;
    visibility?: DocVisibility;
    /** Who uploaded it: the file's creator, and its version 1's uploader and promoter. */
    uploaderId: string;
    /** The owners, in order. */
    ownerIds: readonly string[];
    bytes: VersionBytes;
  },
): Promise<{ id: string; slug: string; title: string; versionId: string }> {
  const { bytes } = opts;
  const file = await tx.storedFile.create({
    data: {
      slug: opts.slug,
      title: opts.title,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      createdByUserId: opts.uploaderId,
      updatedByUserId: opts.uploaderId,
      // "Owner" rather than "author" because nobody here wrote the PDF
      // (schema.prisma's FileOwner). It is also what makes the file visible
      // to them at all under PRIVATE, which is the default.
      owners: { create: opts.ownerIds.map((userId, ownerOrder) => ({ userId, ownerOrder })) },
    },
    select: { id: true, slug: true, title: true },
  });

  const tail = await tx.ydocUpdate.aggregate({ _max: { id: true } });
  const updateId = tail._max.id ?? BigInt(0);
  const now = new Date();
  const version = await tx.fileVersion.create({
    data: {
      fileId: file.id,
      number: 1,
      filename: bytes.filename,
      contentType: bytes.contentType,
      byteSize: bytes.byteSize,
      sha256: bytes.sha256,
      pageCount: bytes.pageCount,
      ...(bytes.metadata
        ? { pageLabels: bytes.metadata.pageLabels as Prisma.InputJsonValue, outline: bytes.metadata.outline as Prisma.InputJsonValue }
        : {}),
      uploadedAt: now,
      uploadedByUserId: opts.uploaderId,
      promotedAt: now,
      promotedByUserId: opts.uploaderId,
      uploadedAtUpdateId: updateId,
      promotedAtUpdateId: updateId,
    },
    select: { id: true },
  });
  // Only a parsed format has page text. A .docx stores none, which is what
  // its null pageCount says as well.
  if (bytes.pages) {
    const { textVersion, texts } = bytes.pages;
    await tx.filePageText.createMany({
      data: texts.map((text, pageIndex) => ({ fileVersionId: version.id, pageIndex, textVersion, text })),
    });
  }
  // Raw, so the file's `updatedAt` stays the one its insert stamped: a Prisma
  // update would move it, and it is the date a search hit shows.
  await tx.$executeRaw`UPDATE "file" SET "current_version_id" = ${version.id} WHERE "id" = ${file.id}`;
  return { ...file, versionId: version.id };
}

/** The version a note is on, as a listing names and links it. */
export type NoteVersion = { id: string; number: number; isLatest: boolean };

/**
 * Which version each of these notes is on: its own for a root with a PDF
 * target, and its root's for a reply at any depth, since a reply has no
 * target and travels with its root (docs/PDF.md §13, "Versions").
 *
 * **Every listing of single notes goes through this** (`/annotations`,
 * search, a reference's cited-by, mentions, MCP's threads, the raise email),
 * for the title it shows (`fileVersionTitle`) and the link it builds
 * (`pdfPath`). Reading a row's own `file_version_id` instead answers nothing
 * for a reply, which would then be linked at the bare address and land on
 * its root's entry, not its card.
 *
 * A note absent from the map has no version: a doc's note, or one on a file
 * whose root has no target, which is the file's and is listed on every
 * version's page.
 */
export async function noteVersions(annotationIds: readonly string[]): Promise<Map<string, NoteVersion>> {
  if (annotationIds.length === 0) return new Map();
  const rows = await prismaIncludingDeleted.$queryRaw<{ id: string; versionId: string; number: number; isLatest: boolean }[]>(Prisma.sql`
    WITH RECURSIVE up AS (
      SELECT a.id AS start_id, a.parent_annotation_id, a.file_version_id
      FROM annotation a WHERE a.id = ANY(${[...annotationIds]})
      UNION ALL
      SELECT up.start_id, p.parent_annotation_id, p.file_version_id
      FROM up JOIN annotation p ON p.id = up.parent_annotation_id
    )
    SELECT up.start_id AS id, v.id AS "versionId", v.number, (f.current_version_id = v.id) AS "isLatest"
    FROM up
    JOIN file_version v ON v.id = up.file_version_id
    JOIN file f ON f.id = v.file_id
    WHERE up.parent_annotation_id IS NULL`);
  return new Map(rows.map((row) => [row.id, { id: row.versionId, number: row.number, isLatest: row.isLatest }]));
}

/** One version of a file, as its page, its banner and the version list show it. */
export type FileVersionSummary = {
  id: string;
  number: number;
  state: FileVersionState;
  sha256: string;
  filename: string;
  byteSize: number;
  pageCount: number | null;
  uploadedAt: string;
  uploadedBy: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
  abandonedAt: string | null;
};

/** The select `summariseVersions` reads, for a file query that takes its versions along. */
export const VERSION_SUMMARY_SELECT = {
  id: true,
  number: true,
  sha256: true,
  filename: true,
  byteSize: true,
  pageCount: true,
  uploadedAt: true,
  promotedAt: true,
  abandonedAt: true,
  uploadedBy: { select: { name: true } },
  promotedBy: { select: { name: true } },
} as const satisfies Prisma.FileVersionSelect;

type VersionSummaryRow = Prisma.FileVersionGetPayload<{ select: typeof VERSION_SUMMARY_SELECT }>;

/** A file's versions, in number order, each with its state. */
export function summariseVersions(file: { currentVersionId: string | null; versions: readonly VersionSummaryRow[] }): FileVersionSummary[] {
  return [...file.versions]
    .sort((a, b) => a.number - b.number)
    .map((version) => ({
      id: version.id,
      number: version.number,
      state: fileVersionState(version, file.currentVersionId),
      sha256: version.sha256,
      filename: version.filename,
      byteSize: version.byteSize,
      pageCount: version.pageCount,
      uploadedAt: version.uploadedAt.toISOString(),
      uploadedBy: version.uploadedBy ? displayNameOf(version.uploadedBy) : null,
      promotedAt: version.promotedAt?.toISOString() ?? null,
      promotedBy: version.promotedBy ? displayNameOf(version.promotedBy) : null,
      abandonedAt: version.abandonedAt?.toISOString() ?? null,
    }));
}

/**
 * What the version list gives whoever may manage the file (docs/PDF.md §13,
 * "Addresses"): never sent for any other reader.
 */
export type VersionManage = {
  fileId: string;
  /** Whether the file takes a new version at all: a PDF does, a .docx doesn't. */
  takesVersions: boolean;
  /** How many posted notes are on each version, by version id: what is still on an earlier one, which nothing moves yet. */
  notesOn: Record<string, number>;
  /** What a promotion of the waiting version would do to the file's citations; null where none waits. */
  candidateFacts: { unlabelled: boolean; pagedCitations: number | null } | null;
};

/**
 * How many posted notes are on each of a file's versions, by version id: its
 * roots with a PDF target, DRAFTs and deleted ones left out. A reply has no
 * version of its own and is with its root, so it is not counted apart.
 */
export async function postedNotesByVersion(fileId: string): Promise<Record<string, number>> {
  const rows = await prisma.annotation.groupBy({
    by: ["fileVersionId"],
    where: { fileId, fileVersionId: { not: null }, status: { not: "DRAFT" }, deletedByUserId: null },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.flatMap((row) => (row.fileVersionId ? [[row.fileVersionId, row._count._all]] : [])));
}

/** A capture's origin with the file it is into: what its write checks. */
export type CaptureClaim = CaptureOrigin & { fileId: string };

/** A capture refused for the version it names. The message is for whoever made it. */
export class CaptureRefused extends Error {
  constructor(
    readonly reason: "reload" | "candidate" | "abandoned" | "not-this-file",
    message: string,
  ) {
    super(message);
    this.name = "CaptureRefused";
  }
}

/**
 * Checks the version a capture names, **inside the transaction that inserts
 * its row and with the file row locked** (docs/PDF.md §13, "Versions"): a
 * posted note, a draft opened on a selection, a part added to a link, and
 * MCP's `anchorPdfQuote`. Throws `CaptureRefused`, which rolls the insert
 * back.
 *
 * - **From the bare address the version must still be the latest.** A viewer
 *   left open there across a promotion still shows the old bytes and isn't
 *   told, and its writer means the latest: the capture is refused with a
 *   reload message, as the schema gate refuses a stale tab, rather than
 *   landing on an earlier version unseen.
 * - **From a version's own address the version must be promoted**, and not
 *   abandoned. That page names its version in its title, so its writer has
 *   been told which it is. A candidate takes no note and no link part:
 *   abandoning it removes the sheets the anchor was measured on.
 *
 * **Why inside the transaction.** Checked before it, a promotion can commit
 * between the check and the insert, and the note lands on an earlier version
 * with nothing said. The lock is `FOR SHARE`: it conflicts with the update a
 * promotion makes to `current_version_id`, which then waits for this
 * transaction, and not with another capture's, so two readers annotating one
 * file don't queue behind each other.
 */
export async function assertCaptureVersion(tx: TransactionClient, claim: CaptureClaim): Promise<void> {
  const [file] = await tx.$queryRaw<{ currentVersionId: string | null }[]>(
    Prisma.sql`SELECT "current_version_id" AS "currentVersionId" FROM "file" WHERE "id" = ${claim.fileId} FOR SHARE`,
  );
  const version = file
    ? await tx.fileVersion.findFirst({
        where: { id: claim.fileVersionId, fileId: claim.fileId },
        select: { number: true, promotedAt: true, abandonedAt: true },
      })
    : null;
  if (!file || !version) throw new CaptureRefused("not-this-file", "That isn't a version of this file.");
  if (claim.address === "bare") {
    if (claim.fileVersionId !== file.currentVersionId) throw new CaptureRefused("reload", CAPTURE_RELOAD_MESSAGE);
    return;
  }
  if (version.abandonedAt !== null) {
    throw new CaptureRefused("abandoned", `Version ${version.number} of this file was abandoned, so nothing more can be anchored on it.`);
  }
  if (version.promotedAt === null) {
    throw new CaptureRefused("candidate", `Version ${version.number} is not yet this file's latest, and takes no notes or link parts until it is.`);
  }
}
