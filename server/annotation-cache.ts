import type * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { annotationContentExtensions } from "../src/lib/tiptap-schema";
import { extractText } from "../src/lib/diff";
import { annotationIdFromYdocId } from "../src/lib/ydoc-names";
import { prisma } from "../src/lib/prisma";
import type { Prisma } from "../src/generated/prisma/client";

// The annotation-side twin of doc-cache.ts (PLAN.md §13a) — writes
// Annotation.proseJson/bodyText from the live ydoc, called from
// ydocOnStoreDocument's debounce for every ydoc-stack document, annotation
// or not. annotationIdFromYdocId(ydocId) is what actually decides "is this
// an annotation's ydoc" — it matches zero rows for anything else (a doc, or
// a bare /ydoc-debug document), so this is safe to call unconditionally
// alongside updateDocCache; the two never both match the same documentName
// (§13a's namespace guard). No title fragment — an annotation has none.
export async function updateAnnotationCache(
  ydocId: string,
  document: Y.Doc,
  // PLAN.md §13q — which update of this annotation's own ydoc the content
  // below is. Optional because the callers that flush without a collab server
  // in the loop don't know one; omitted rather than nulled, so an unknown
  // value never overwrites a known one.
  lastUpdateId?: bigint | null,
): Promise<void> {
  const annotationId = annotationIdFromYdocId(ydocId);
  if (!annotationId) return;

  let bodyJSON: unknown;
  try {
    bodyJSON = TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(document, "default");
  } catch (err) {
    console.error(`[annotation-cache] ${ydocId} isn't TipTap-compatible, leaving prose_json unchanged:`, err);
    return;
  }

  try {
    await prisma.annotation.updateMany({
      where: { id: annotationId },
      data: {
        proseJson: bodyJSON as Prisma.InputJsonValue,
        bodyText: extractText(bodyJSON),
        ...(lastUpdateId === undefined || lastUpdateId === null ? {} : { proseJsonUpdateId: lastUpdateId }),
      },
    });
  } catch (err) {
    console.error(`[annotation-cache] failed to update prose_json for ${ydocId}:`, err);
  }
}
