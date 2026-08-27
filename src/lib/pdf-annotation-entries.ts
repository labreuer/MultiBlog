import { getFileAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import type { PdfAnnotationEntry } from "@/components/pdf/PdfAnnotationPanel";

// PLAN.md §19 Phase 3 — every annotation on one file, in the shape the PDF
// panel renders.
//
// Server-only: `buildAnnotationEntries` runs @tiptap/static-renderer, whose
// output is a React element that ships in the RSC payload. That is also why
// this is worth having as one function rather than two copies — /pdf/[slug]
// renders it for the first paint and `loadPdfAnnotationEntries` returns it
// after a post, and a panel fed two subtly different transforms would show
// cards that change shape the moment anyone annotates.
//
// The thread → entry transform is identical for both containers; only the PDF
// target is extra, joined back on **by thread id** rather than by position so
// it cannot depend on buildAnnotationEntries' ordering.
//
// No permission check of its own — it takes a resolved file id, and each
// caller has already run the gate (`canUserReadFile`). Same arrangement, and
// the same reason, as tagsForTarget.
export async function pdfAnnotationEntriesFor(fileId: string): Promise<PdfAnnotationEntry[]> {
  const threads = await getFileAnnotationsAsThreads(fileId);
  const targets = new Map(threads.map((thread) => [thread.id, thread.pdfTarget]));
  return buildAnnotationEntries(threads).map((entry) => ({
    threadId: entry.threadId,
    quotedText: entry.quotedText,
    color: entry.color,
    target: targets.get(entry.threadId) ?? null,
    root: entry.root,
  }));
}
