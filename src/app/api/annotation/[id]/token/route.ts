import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserAccessAnnotationYdoc } from "@/lib/annotation-authz";
import { signYdocToken } from "@/lib/ydoc-token";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";

// The annotation-scoped sibling of /api/doc/[id]/token (PLAN.md §13a) — one
// gate, always writable when it passes: canUserAccessAnnotationYdoc already
// collapses "may read" and "may write" into a single question for an
// annotation (§13a's own comment explains why a doc's writable/readOnly
// split doesn't apply here), so there's no readOnly branch to compute.
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

  // Lineage mirrors /api/doc/[id]/token: the ydoc row's own created_at, not
  // Annotation.createdAt — the two coincide at ordinary creation time but
  // only the former tracks a structurally new document (PLAN.md §11e).
  const documentName = ydocIdForAnnotation(id);
  const ydocRow = await prisma.ydoc.findUnique({ where: { id: documentName }, select: { createdAt: true } });
  if (!ydocRow) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const token = await signYdocToken({ sub: session.user.id, documentName, role: session.user.role });
  return NextResponse.json({ token, lineage: ydocRow.createdAt.getTime(), documentName });
}
