import { prisma } from "@/lib/prisma";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { usablePageLabels } from "@/lib/pdf-page-labels";

// docs/MCP.md §8 — a file version's page labels for a read: stored one string per
// page, filled lazily (src/lib/pdf-metadata.ts), and shown as ranges
// (pdf-page-labels.ts's `labelRanges`). **Labels are a lookup, never a
// coordinate**: a request may name pages by label, but every stored anchor
// keeps `pageIndex` (PDF.md).

/** A version's labels worth showing, as the viewer applies `usablePageLabels`; null where the PDF numbers its pages plainly. */
export async function pdfLabels(fileVersionId: string): Promise<string[] | null> {
  const [metadata, version] = await Promise.all([
    pdfMetadata(fileVersionId),
    prisma.fileVersion.findUnique({ where: { id: fileVersionId }, select: { pageCount: true } }),
  ]);
  if (!metadata || !version?.pageCount) return null;
  return usablePageLabels(metadata.pageLabels, version.pageCount);
}
