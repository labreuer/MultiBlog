import type { Actor } from "@/lib/actor";
import { readableFilesWhere } from "@/lib/file-authz";
import { contentTypeForKind } from "@/lib/file-format";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { cslOf } from "@/lib/references/csl";
import { entryText } from "@/lib/references/entry";

// docs/CITATIONS.md, "A work's PDF" — the reads behind the two places a
// reference is tied to its PDF: the PDF's own page, and the File column of
// /references. A reference's record is public, so which references a PDF
// is the PDF of is asked only by a page that has already checked its reader
// may read the PDF; which PDFs may be tied goes through the files' read
// rule, as every listing of files does.
//
// Server-only.

/** The content type a reference's file has: a citation's page is a page of a PDF. */
export const PDF_CONTENT_TYPE = contentTypeForKind("pdf");

/** A reference as the PDF's page lists it. */
export type FileReference = { id: string; key: string; entry: string };

/** The live references this file is the PDF of, by key. For a page whose reader may read the file. */
export async function referencesOfFile(fileId: string): Promise<FileReference[]> {
  const rows = await prismaIncludingDeleted.reference.findMany({
    where: { fileId, deletedAt: null },
    select: { id: true, key: true, csl: true },
    orderBy: { key: "asc" },
  });
  return rows.map((row) => {
    const item = cslOf(row.csl);
    return { id: row.id, key: row.key, entry: item ? entryText(item) : row.key };
  });
}

/** A PDF a reference can be tied to, as the File column's picker offers it. */
export type PdfCandidate = { id: string; slug: string; title: string; private: boolean };

/** The PDFs this reader may read whose title, slug or file name holds every word of `query`, the latest first. */
export async function findReadablePdfs(actor: Actor, query: string, limit: number): Promise<PdfCandidate[]> {
  const readable = readableFilesWhere(actor.userId, actor.role);
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!readable || words.length === 0) return [];
  const rows = await prisma.storedFile.findMany({
    where: {
      AND: [
        readable,
        { currentVersion: { contentType: PDF_CONTENT_TYPE } },
        ...words.map((word) => ({
          OR: [
            { title: { contains: word, mode: "insensitive" as const } },
            { slug: { contains: word, mode: "insensitive" as const } },
            { currentVersion: { filename: { contains: word, mode: "insensitive" as const } } },
          ],
        })),
      ],
    },
    select: { id: true, slug: true, title: true, visibility: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit,
  });
  return rows.map((row) => ({ id: row.id, slug: row.slug, title: row.title, private: row.visibility === "PRIVATE" }));
}

/** Of these files, the ones this reader may read, live ones only, by id: what /references and `find_refs` name. */
export async function readableFiles(actor: Actor, ids: readonly string[]): Promise<Map<string, { slug: string; title: string; private: boolean }>> {
  const readable = readableFilesWhere(actor.userId, actor.role);
  if (!readable || ids.length === 0) return new Map();
  const rows = await prisma.storedFile.findMany({
    where: { AND: [readable, { id: { in: [...ids] } }] },
    select: { id: true, slug: true, title: true, visibility: true },
  });
  return new Map(rows.map((row) => [row.id, { slug: row.slug, title: row.title, private: row.visibility === "PRIVATE" }]));
}
