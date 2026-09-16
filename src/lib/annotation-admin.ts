import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import { collabHttpOrigin } from "./collab-http-origin";
import {
  ydocIdForDoc,
  ydocIdForAnnotation,
  ANNOTATION_MARK_PATH,
  ANNOTATION_UNMARK_PATH,
  ANNOTATION_FLUSH_PATH,
  ANNOTATION_REPLACE_PATH,
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
 * Asks the collab server for the drained tail of `annotationId`'s own update
 * log — the mark a settle materialises, validates and snapshots at (PLAN.md
 * §22e) — and, unless `writeCache` is false, has it write
 * server/annotation-cache.ts's proseJson/bodyText from the live document at
 * the same time rather than waiting for the next store debounce (§13j
 * Phase 3, what `saveDraftAnnotation` wants).
 *
 * The settle paths pass `writeCache: false` and write the cache themselves,
 * from the body they validated, in the same transaction as the snapshot.
 *
 * Returns `null` on any failure. Never throws: the caller can still read the
 * log's tail from the database itself, and a keystroke that had not landed by
 * then is what its bounded retry is for. Every failure path logs, because
 * "the flush silently did nothing" once surfaced as *"Annotation can't be
 * empty."* on every post made within the store debounce — the production
 * symptom of the NEXT_PUBLIC_COLLAB_URL misrouting (PLAN.md §13m).
 */
export async function flushAnnotationCache(opts: {
  userId: string;
  role: Role;
  annotationId: string;
  writeCache?: boolean;
}): Promise<bigint | null> {
  const { userId, role, annotationId } = opts;
  const documentName = ydocIdForAnnotation(annotationId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  let response: Response;
  try {
    response = await fetch(`${collabHttpOrigin()}${ANNOTATION_FLUSH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName, ...(opts.writeCache === false ? { writeCache: false } : {}) }),
    });
  } catch (err) {
    console.error(`[annotation-admin] annotation-flush unreachable for ${documentName}:`, err);
    return null;
  }
  if (!response.ok) {
    console.error(`[annotation-admin] annotation-flush returned ${response.status} for ${documentName}`);
    return null;
  }
  // Same guard as applyAnnotationMark's: a misrouted request gets Hocuspocus's
  // plain-text "Welcome to Hocuspocus!" 200, and a parse that threw here would
  // surface as a generic 500 from the action rather than the log line that
  // makes it findable.
  try {
    const { lastUpdateId } = (await response.json()) as { lastUpdateId: string | null };
    return lastUpdateId === null ? null : BigInt(lastUpdateId);
  } catch (err) {
    console.error(`[annotation-admin] annotation-flush answered non-JSON for ${documentName} — is the endpoint routed correctly?`, err);
    return null;
  }
}

/**
 * Puts `proseJson` back as an annotation body's whole content, through the
 * collab server so every connected client sees it (PLAN.md §22e).
 *
 * Cancel on an edit session is the only caller. **Not best-effort**, unlike
 * its neighbours here: a failed mark leaves an annotation document-level,
 * which the system already renders sensibly, but a failed restore leaves the
 * *abandoned draft* as the live body while the row says the session was
 * cancelled. So this reports failure and `cancelAnnotationEdit` keeps the
 * session open rather than pretending it rolled back.
 */
export async function replaceAnnotationBody(opts: {
  userId: string;
  role: Role;
  annotationId: string;
  proseJson: unknown;
}): Promise<{ replaced: boolean; updateId: string | null }> {
  const { userId, role, annotationId, proseJson } = opts;
  const documentName = ydocIdForAnnotation(annotationId);
  const token = await signYdocToken({ sub: userId, documentName, role });

  try {
    const response = await fetch(`${collabHttpOrigin()}${ANNOTATION_REPLACE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, documentName, proseJson }),
    });
    if (!response.ok) {
      console.error(`[annotation-admin] annotation-replace returned ${response.status} for ${documentName}`);
      return { replaced: false, updateId: null };
    }
    const { updateId } = (await response.json()) as { updateId: string | null };
    return { replaced: true, updateId };
  } catch (err) {
    console.error(`[annotation-admin] annotation-replace unreachable for ${documentName}:`, err);
    return { replaced: false, updateId: null };
  }
}
