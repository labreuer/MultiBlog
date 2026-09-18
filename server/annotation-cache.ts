import type * as Y from "yjs";
import { decodeAnnotationBody } from "../src/lib/annotation-body";
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
  // PLAN.md §22e — set by the store debounce and by nothing else.
  //
  // While `Annotation.editingSince` is non-null, an edit session is open and
  // the two cache columns are meant to hold the **last settled** body, not
  // whatever has been typed since. That is what keeps every reader path
  // (annotation-entries.ts, both rails, /annotations,
  // getDocAnnotationsAsThreads) rendering a whole sentence rather than a
  // half-typed one, with no change to any of them.
  //
  // The flush endpoint deliberately does not pass it: a flush is an explicit
  // authenticated "write it now", and `saveDraftAnnotation` is the caller
  // asking. The settle paths (post, Done) do not come through here at all —
  // they write the cache themselves from the body they validated, in the
  // same transaction as the version's snapshot. So the guard lives in the
  // *ambient* writer and not in the deliberate one.
  opts?: { skipWhileEditing?: boolean },
): Promise<void> {
  const annotationId = annotationIdFromYdocId(ydocId);
  if (!annotationId) return;

  // The same decode the settle path runs on a materialised body
  // (src/lib/annotation-body.ts), so the cache and a settled version can be
  // compared as text without the comparison measuring the decoders.
  let body: ReturnType<typeof decodeAnnotationBody>;
  try {
    body = decodeAnnotationBody(document);
  } catch (err) {
    console.error(`[annotation-cache] ${ydocId} isn't TipTap-compatible, leaving prose_json unchanged:`, err);
    return;
  }

  try {
    await prisma.annotation.updateMany({
      // The guard is a `where` clause rather than a read-then-decide, so a
      // session opening between the two is not a race this can lose.
      where: { id: annotationId, ...(opts?.skipWhileEditing ? { editingSince: null } : {}) },
      data: {
        proseJson: body.proseJson as Prisma.InputJsonValue,
        bodyText: body.bodyText,
        ...(lastUpdateId === undefined || lastUpdateId === null ? {} : { proseJsonUpdateId: lastUpdateId }),
      },
    });
  } catch (err) {
    console.error(`[annotation-cache] failed to update prose_json for ${ydocId}:`, err);
  }
}
