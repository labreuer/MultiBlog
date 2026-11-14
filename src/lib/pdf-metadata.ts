import { readFile } from "node:fs/promises";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import { storagePathFor } from "./file-storage";
import { extractPdfMetadata, type PdfMetadata, type StoredOutlineEntry } from "./pdf-extract";

// docs/MCP.md §8 — a PDF's page labels and outline, stored on its
// `file_version` (they are a property of the bytes, so not on
// `file_page_text`, whose rows are per text version), filled lazily on first
// read — following `storedPageText`'s precedent, so there is no deploy-time
// backfill to forget.
//
// **By version** (docs/PDF.md §13, "Versions"): a caller that means the
// latest passes `file.current_version_id`. The fill parses for seconds and
// then writes to the version it parsed, never to "the file's latest" looked
// up afterwards.
//
// A `file_version` row has no `updatedAt`, so the fill is a plain update: a
// file's `updatedAt` (search's "updated" date for a PDF, and the date its hit
// shows) is another row's and doesn't move.
//
// Server-only (node:fs).

const inFlight = new Map<string, Promise<PdfMetadata | null>>();

/** A version's stored labels and outline, extracted and stored first when missing; null for one that isn't a PDF's or has no bytes. */
export async function pdfMetadata(fileVersionId: string): Promise<PdfMetadata | null> {
  const row = await prisma.fileVersion.findUnique({
    where: { id: fileVersionId },
    select: { sha256: true, pageCount: true, pageLabels: true, outline: true, abandonedAt: true },
  });
  if (!row || row.pageCount === null) return null;
  if (Array.isArray(row.pageLabels) && Array.isArray(row.outline)) {
    return { pageLabels: row.pageLabels as string[], outline: row.outline as StoredOutlineEntry[] };
  }
  // An abandoned version keeps the labels it had and has no bytes to read more from.
  if (row.abandonedAt !== null) return null;
  let pending = inFlight.get(fileVersionId);
  if (!pending) {
    pending = fill(fileVersionId, row.sha256).finally(() => inFlight.delete(fileVersionId));
    inFlight.set(fileVersionId, pending);
  }
  return pending;
}

async function fill(fileVersionId: string, sha256: string): Promise<PdfMetadata | null> {
  let metadata: PdfMetadata;
  try {
    metadata = await extractPdfMetadata(await readFile(storagePathFor(sha256)));
  } catch (err) {
    console.error(`[pdf-metadata] couldn't read labels and outline of file version ${fileVersionId}:`, err);
    return null;
  }
  await prisma.fileVersion.update({
    where: { id: fileVersionId },
    data: {
      pageLabels: metadata.pageLabels as Prisma.InputJsonValue,
      outline: metadata.outline as unknown as Prisma.InputJsonValue,
    },
  });
  return metadata;
}
