import { prisma } from "./prisma";
import { canUserEditAnnotationBody } from "./annotation-authz";
import { signYdocToken } from "./ydoc-token";
import { ydocIdForAnnotation } from "./ydoc-names";
import type { Role } from "@/generated/prisma/enums";

// Everything a client needs to open a connection to one annotation's body
// ydoc — exactly what `POST /api/annotation/[id]/token` answers with, and now
// also what `createDraftAnnotation` and `beginAnnotationEdit` hand back.
//
// **Why the actions mint one at all.** An annotation is a document on the
// page's one shared socket (docs/YDOC.md "One socket per page"), so there is
// no handshake left to pay for — what opening one costs is HTTP, and it used
// to cost it twice over, serially: the action that creates the DRAFT row (or
// stamps `editingSince`), and then `useAnnotationProvider`'s own fetch of
// this bundle. The second asks a question the first already answered — both
// gate on the same annotation, and the action has strictly *more* certainty
// about it than the route does, since it just wrote the row. So the action
// returns the bundle and the hook skips its fetch. The route stays, and stays
// the only path for a composer mounted on a row somebody else created (a
// moved draft, `OwnDraftsList`, the editor's rail), and for every
// *re*connect.
//
// The token lives two minutes (`signYdocToken`), so a bundle is good for the
// first connection attempt and nothing else. That is all it is used for:
// `useAnnotationProvider` consumes it once and every later attempt goes
// through the refresher, which mints a fresh one over HTTP.
export type AnnotationConnectionBundle = {
  token: string;
  /** The ydoc row's own `created_at`, epoch ms — PLAN.md §11e's lineage key. */
  lineage: number;
  documentName: string;
  readOnly: boolean;
};

/**
 * Mints the connection bundle for an annotation whose *access* gate the
 * caller has already passed (`canUserAccessAnnotationYdoc`, or the equivalent
 * the action ran on its own way in).
 *
 * **`readOnly` is decided here, never passed in.** The caller supplies a
 * fact — whose annotation this is — and this function asks the policy
 * question about it. The distinction matters because the answer goes into a
 * signed token that `server/ydoc-hooks.ts` then trusts: a caller allowed to
 * assert "writable" could mint write access to anyone's body by getting one
 * boolean wrong, whereas a caller that gets `annotationUserId` wrong is
 * making the same class of mistake as getting `annotationId` wrong.
 *
 * Returns null when the body has no `ydoc` row — a 404 to the route, and to
 * an action just "no bundle", which degrades to the client fetching one and
 * getting the same 404 from the route.
 */
export async function mintAnnotationConnection(opts: {
  annotationId: string;
  /** The annotation's own `Annotation.userId`, which every caller's gate already loaded. */
  annotationUserId: string;
  viewer: { id: string; role: Role };
}): Promise<AnnotationConnectionBundle | null> {
  const documentName = ydocIdForAnnotation(opts.annotationId);
  // Lineage mirrors /api/doc/[id]/token: the ydoc row's own created_at, not
  // Annotation.createdAt — the two coincide at ordinary creation time but
  // only the former tracks a structurally new document (PLAN.md §11e).
  const ydocRow = await prisma.ydoc.findUnique({ where: { id: documentName }, select: { createdAt: true } });
  if (!ydocRow) {
    return null;
  }

  const readOnly = !canUserEditAnnotationBody(opts.viewer.id, opts.viewer.role, { userId: opts.annotationUserId });
  const token = await signYdocToken({
    sub: opts.viewer.id,
    documentName,
    role: opts.viewer.role,
    // Absent rather than false when writable, matching YdocTokenPayload's own
    // comment: ydocOnAuthenticate's default is writable, and only a truthy
    // flag narrows it.
    ...(readOnly ? { readOnly: true } : {}),
  });
  return { token, lineage: ydocRow.createdAt.getTime(), documentName, readOnly };
}
