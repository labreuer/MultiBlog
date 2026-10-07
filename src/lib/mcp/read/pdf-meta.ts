import { prisma } from "@/lib/prisma";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { usablePageLabels } from "@/lib/pdf-page-labels";

// docs/MCP.md §8 — a file's page labels for a read: stored one string per
// page, filled lazily (src/lib/pdf-metadata.ts), and shown as ranges
// (pdf-page-labels.ts's `labelRanges`). **Labels are a lookup, never a
// coordinate**: a request may name pages by label, but every stored anchor
// keeps `pageIndex` (PDF.md).

/** The labels worth showing, as the viewer applies `usablePageLabels`; null where the PDF numbers its pages plainly. */
export async function pdfLabels(fileId: string): Promise<string[] | null> {
  const [metadata, file] = await Promise.all([
    pdfMetadata(fileId),
    prisma.storedFile.findUnique({ where: { id: fileId }, select: { pageCount: true } }),
  ]);
  if (!metadata || !file?.pageCount) return null;
  return usablePageLabels(metadata.pageLabels, file.pageCount);
}
