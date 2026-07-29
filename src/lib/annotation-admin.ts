import type { Role } from "@/generated/prisma/enums";
import { signYdocToken } from "./ydoc-token";
import { ydocIdForDoc, ANNOTATION_MARK_PATH } from "./ydoc-names";

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
 * an expected outcome the caller (submitAnnotation) already renders as a
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
