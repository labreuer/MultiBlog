import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import {
  ydocIdForDoc,
  ydocIdForAnnotation,
  ANNOTATION_MARK_PATH,
  ANNOTATION_UNMARK_PATH,
  ANNOTATION_FLUSH_PATH,
} from "./ydoc-names";

// Server-to-server channel from the Next app to the Hocuspocus server for
// applying an annotation's mark to its doc's live document (PLAN.md §12i) —
// the doc-side sibling of collab-admin.ts's replaceCollabDoc, same idiom:
// mint a short-lived token naming the document, POST it to the collab
// server's HTTP port, let the collab process make the actual Yjs change so
// it reaches every connected client (editor and readers) live.
//
// NEXT_PUBLIC_COLLAB_URL is a websocket URL; collabHttpOrigin below is
// duplicated from collab-admin.ts rather than imported — see PLAN.md §11's
// isolation constraint for why collab-admin.ts (a post-side file) isn't
// touched by this doc-side work.
function collabHttpOrigin(): string {
  const wsUrl = process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://localhost:${process.env.COLLAB_PORT ?? 1234}`;
  return wsUrl.replace(/^ws/, "http").replace(/\/$/, "");
}

/**
 * Applies a mark carrying `annotationId` over [from, to) in `docId`'s live
 * document. Returns `applied: false` (not a thrown error) when the offsets
 * no longer match `quotedText` and no unique fallback occurrence exists —
 * an expected outcome the caller (postAnnotation) already renders as a
 * document-level annotation, not a failure to surface.
 *
 * Throws only when the collab server itself couldn't be reached or rejected
 * the request outright — the annotation row the caller already inserted is
 * still valid either way (row-first-mark-second, PLAN.md §12i), so a throw
 * here just means the mark attempt didn't happen and the annotation renders
 * document-level, same as an unfound quote.
 */
export async function applyAnnotationMark(opts: {
  docId: string;
  userId: string;
  role: Role;
  annotationId: string;
  from: number;
  to: number;
  quotedText: string;
}): Promise<{ applied: boolean }> {
  const { docId, userId, role, annotationId, from, to, quotedText } = opts;
  const documentName = ydocIdForDoc(docId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  let response: Response;
  try {
    response = await fetch(`${collabHttpOrigin()}${ANNOTATION_MARK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName, annotationId, from, to, quotedText }),
    });
  } catch {
    return { applied: false };
  }

  if (!response.ok) {
    return { applied: false };
  }
  const result = (await response.json()) as { applied: boolean };
  return result;
}

/**
 * Removes every mark instance carrying `annotationId` from `docId`'s live
 * document, wherever it currently sits (PLAN.md §13d) — the reverse of
 * applyAnnotationMark, called from deleteAnnotation so a deleted
 * annotation's highlight doesn't keep showing on text whose annotation is
 * gone (a pre-existing gap: nothing had ever called this before §13d).
 *
 * Best-effort, same reasoning as flushAnnotationCache: the annotation row
 * is already being deleted regardless of whether this succeeds, so a
 * failure here just means a stray highlight lingers until the next edit
 * touches that text — not worth blocking the delete over.
 */
export async function removeAnnotationMark(opts: { docId: string; userId: string; role: Role; annotationId: string }): Promise<void> {
  const { docId, userId, role, annotationId } = opts;
  const documentName = ydocIdForDoc(docId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  try {
    await fetch(`${collabHttpOrigin()}${ANNOTATION_UNMARK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName, annotationId }),
    });
  } catch {
    // Best-effort — see the doc comment above.
  }
}

/**
 * Forces server/annotation-cache.ts's proseJson/bodyText write for
 * `annotationId` immediately rather than waiting for the next store
 * debounce (PLAN.md §13j Phase 3) — called from postAnnotation right before
 * flipping DRAFT to LIVE, so a reader who opens the annotation the instant
 * it becomes visible sees what was actually typed, not whatever the cache
 * still held as of the last debounce (for a brand-new annotation, that's
 * its creation-time empty paragraph).
 *
 * Best-effort: a failure here just means the reader briefly sees stale
 * (empty) content until the next real edit's debounce catches up — not
 * worth blocking Post over, so this never throws.
 */
export async function flushAnnotationCache(opts: { userId: string; role: Role; annotationId: string }): Promise<void> {
  const { userId, role, annotationId } = opts;
  const documentName = ydocIdForAnnotation(annotationId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  try {
    await fetch(`${collabHttpOrigin()}${ANNOTATION_FLUSH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName }),
    });
  } catch {
    // Best-effort — see the doc comment above.
  }
}
