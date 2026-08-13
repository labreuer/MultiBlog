import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import { collabHttpOrigin } from "./collab-http-origin";
import {
  ydocIdForDoc,
  ydocIdForAnnotation,
  ANNOTATION_MARK_PATH,
  ANNOTATION_UNMARK_PATH,
  ANNOTATION_FLUSH_PATH,
} from "./ydoc-names";

// Server-to-server channel from the Next app to the Hocuspocus server for
// applying an annotation's mark to its doc's live document (PLAN.md §12i):
// mint a short-lived token naming the document, POST it to the collab
// server's HTTP port, let the collab process make the actual Yjs change so
// it reaches every connected client (editor and readers) live.
//
// collabHttpOrigin is shared with ydoc-admin.ts rather than duplicated —
// the isolation constraint that once kept the two apart (PLAN.md §11) was
// about the post-side collab-admin.ts, which no longer exists (§15e). Read
// its comment before changing how the origin is derived: getting it from
// NEXT_PUBLIC_COLLAB_URL is what broke every endpoint in this file in
// production (§13m).

/**
 * Applies a mark carrying `annotationId` over [from, to) in `docId`'s live
 * document. Returns `applied: false` (not a thrown error) when the offsets
 * no longer match `quotedText` and no unique fallback occurrence exists —
 * an expected outcome the caller (postAnnotation) already renders as a
 * document-level annotation, not a failure to surface.
 *
 * Never throws. An unreachable collab server, a non-2xx, and an unparseable
 * body all collapse to `applied: false` and a log line — the annotation row
 * the caller already inserted is valid either way (row-first-mark-second,
 * PLAN.md §12i), so all any of them means is that the mark attempt didn't
 * happen and the annotation renders document-level, same as an unfound
 * quote. (This comment used to promise a throw on those first two, which was
 * already untrue of the unreachable case; the parse was the one real throw,
 * and §13m is what it cost.)
 */
export async function applyAnnotationMark(opts: {
  docId: string;
  userId: string;
  role: Role;
  annotationId: string;
  from: number;
  to: number;
  quotedText: string;
  // PLAN.md §13n — `markUpdateId` is the `ydoc_update` row that now carries
  // the mark, stringified because BigInt doesn't survive JSON. Null whenever
  // `applied` is false, and also whenever the collab server couldn't name one
  // (a degraded append path): the caller keeps its earlier stamp rather than
  // inventing one.
}): Promise<{ applied: boolean; markUpdateId: string | null }> {
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
  } catch (err) {
    console.error(`[annotation-admin] annotation-mark unreachable for ${documentName}:`, err);
    return { applied: false, markUpdateId: null };
  }

  if (!response.ok) {
    console.error(`[annotation-admin] annotation-mark returned ${response.status} for ${documentName}`);
    return { applied: false, markUpdateId: null };
  }

  // Not just `await response.json()`. A 200 whose body isn't JSON is exactly
  // what a misrouted request produces — Hocuspocus answers an unmatched path
  // with a plain-text "Welcome to Hocuspocus!" 200 — and letting the parse
  // throw would surface as a generic 500 from postAnnotation rather than the
  // document-level fallback this function's contract promises. Treating it as
  // not-applied keeps the annotation posting either way; the log line is what
  // makes it findable.
  try {
    return (await response.json()) as { applied: boolean; markUpdateId: string | null };
  } catch (err) {
    console.error(`[annotation-admin] annotation-mark answered non-JSON for ${documentName} — is the endpoint routed correctly?`, err);
    return { applied: false, markUpdateId: null };
  }
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
    const response = await fetch(`${collabHttpOrigin()}${ANNOTATION_UNMARK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName, annotationId }),
    });
    if (!response.ok) {
      console.error(`[annotation-admin] annotation-unmark returned ${response.status} for ${documentName}`);
    }
  } catch (err) {
    // Best-effort — see the doc comment above. Logged, not swallowed: the
    // caller can't act on it, but "the mark is still there" is otherwise
    // indistinguishable from a rendering bug.
    console.error(`[annotation-admin] annotation-unmark unreachable for ${documentName}:`, err);
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
 *
 * "Not worth blocking Post over" understates the consequence, though, which
 * is why every failure path below logs. postAnnotation reads bodyText back
 * immediately after calling this and rejects an empty one with "Annotation
 * can't be empty." — so when this silently does nothing, a user who posts
 * within the store debounce (~2s of their last keystroke) is refused
 * outright, with nothing anywhere saying why. That was the production
 * symptom of the NEXT_PUBLIC_COLLAB_URL misrouting (PLAN.md §13m).
 */
export async function flushAnnotationCache(opts: { userId: string; role: Role; annotationId: string }): Promise<void> {
  const { userId, role, annotationId } = opts;
  const documentName = ydocIdForAnnotation(annotationId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  try {
    const response = await fetch(`${collabHttpOrigin()}${ANNOTATION_FLUSH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName }),
    });
    if (!response.ok) {
      console.error(`[annotation-admin] annotation-flush returned ${response.status} for ${documentName}`);
    }
  } catch (err) {
    // Best-effort — see the doc comment above.
    console.error(`[annotation-admin] annotation-flush unreachable for ${documentName}:`, err);
  }
}
