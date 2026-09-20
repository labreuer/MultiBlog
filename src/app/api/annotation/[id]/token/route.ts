import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserAccessAnnotationYdoc } from "@/lib/annotation-authz";
import { mintAnnotationConnection } from "@/lib/annotation-connection";

// The annotation-scoped sibling of /api/doc/[id]/token (PLAN.md §13a), and
// since §22e it has the same two questions a doc's token does: one gate
// deciding whether to mint at all (canUserAccessAnnotationYdoc — "may you
// read the thing this is about"), a second deciding `readOnly`
// (canUserEditAnnotationBody — author or ADMIN). The second one, and the
// minting itself, live in `mintAnnotationConnection`, which the two actions
// that open an annotation share so they can hand the bundle back directly
// rather than making the client come here for it.
//
// **It used to mint an unconditionally writable token**, on the reasoning
// §13a's comment still records: anyone who could post a reply under an
// annotation could help write its live text. Nothing exploited that, because
// no UI opened a connection to a *posted* body — AnnotationBodyReader renders
// the proseJson cache with no provider at all. Once §22e gives a posted body
// an editor, the same token would let any reader of the container rewrite
// anyone's annotation from a console, which docs/COLLAB.md's 2026-08-13 entry
// named as the real gate on mutable bodies. Hence the split, shipped ahead of
// the editor rather than with it.
//
// **This route is still the only path for a reconnect**, and for a composer
// mounted on a row this client didn't just create — a moved draft,
// OwnDraftsList, the editor's rail. What the actions shortcut is the *first*
// connection after an action that already proved the same access.
//
// `readOnly` is returned in the body as well as carried in the token, purely
// so a client can render the right affordances without decoding a JWT; the
// token is the authority, and server/ydoc-hooks.ts is what enforces it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const annotation = await prisma.annotation.findUnique({
    where: { id },
    // Both containers selected, exactly one of which is non-null (PLAN.md §19)
    // — canUserAccessAnnotationYdoc asks whichever it has.
    select: {
      userId: true,
      status: true,
      doc: { select: { id: true, visibility: true } },
      file: { select: { id: true, visibility: true } },
    },
  });
  if (!annotation) {
    return NextResponse.json({ error: "Annotation not found" }, { status: 404 });
  }

  const allowed = await canUserAccessAnnotationYdoc(session.user.id, session.user.role, annotation);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const connection = await mintAnnotationConnection({
    annotationId: id,
    annotationUserId: annotation.userId,
    viewer: { id: session.user.id, role: session.user.role },
  });
  if (!connection) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json(connection);
}
