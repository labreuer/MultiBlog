import { Prisma } from "@/generated/prisma/client";
import type { DocVisibility } from "@/generated/prisma/enums";
import { prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { displayNameOf } from "@/lib/display-name";
import { fileVersionState, type FileVersionState } from "@/lib/file-version";

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
