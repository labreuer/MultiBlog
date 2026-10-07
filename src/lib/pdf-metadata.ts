import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { storagePathFor } from "./file-storage";
import { extractPdfMetadata, type PdfMetadata, type StoredOutlineEntry } from "./pdf-extract";

// docs/MCP.md §8 — a PDF's page labels and outline, stored on `file` (labels
// are a property of the bytes, so not on `file_page_text`, whose rows are per
// text version), filled lazily on first read — following `storedPageText`'s
// precedent, so there is no deploy-time backfill to forget.
//
// **The fill writes with raw SQL**, as FULLTEXT.md §3's backfill does: a
// Prisma `update` stamps `@updatedAt`, and a file's `updatedAt` is search's
// "updated" date for a PDF and the date its hit shows, so through Prisma the
// first reader of an old PDF would make it "updated today".
//
// Server-only (node:fs).

const inFlight = new Map<string, Promise<PdfMetadata | null>>();

/** The stored labels and outline, extracted and stored first when missing; null for a file that isn't a PDF. */
export async function pdfMetadata(fileId: string): Promise<PdfMetadata | null> {
  const row = await prisma.storedFile.findUnique({
    where: { id: fileId },
    select: { sha256: true, pageCount: true, pageLabels: true, outline: true },
  });
  if (!row || row.pageCount === null) return null;
  if (Array.isArray(row.pageLabels) && Array.isArray(row.outline)) {
    return { pageLabels: row.pageLabels as string[], outline: row.outline as StoredOutlineEntry[] };
  }
  let pending = inFlight.get(fileId);
  if (!pending) {
    pending = fill(fileId, row.sha256).finally(() => inFlight.delete(fileId));
    inFlight.set(fileId, pending);
  }
  return pending;
}

async function fill(fileId: string, sha256: string): Promise<PdfMetadata | null> {
  let metadata: PdfMetadata;
  try {
    metadata = await extractPdfMetadata(await readFile(storagePathFor(sha256)));
  } catch (err) {
    console.error(`[pdf-metadata] couldn't read labels and outline of file ${fileId}:`, err);
    return null;
  }
  await prisma.$executeRaw(Prisma.sql`
    UPDATE file SET page_labels = ${JSON.stringify(metadata.pageLabels)}::jsonb,
                    outline = ${JSON.stringify(metadata.outline)}::jsonb
    WHERE id = ${fileId}`);
  return metadata;
}
