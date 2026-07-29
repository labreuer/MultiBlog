import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditDoc } from "@/lib/doc-authz";
import { signYdocToken } from "@/lib/ydoc-token";
import { ydocIdForDoc } from "@/lib/ydoc-names";

// Doc-scoped sibling of /api/ydoc/[id]/token (that route stays ADMIN-gated
// and /ydoc-debug-only, PLAN.md §12g). Writable only for now — the readOnly
// branch for a SHARED doc's non-editor readers lands in Phase 2 (§12d)
// alongside the reading route that needs it.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const doc = await prisma.doc.findUnique({ where: { id }, select: { id: true } });
  if (!doc) {
    return NextResponse.json({ error: "Doc not found" }, { status: 404 });
  }

  const allowed = await canUserEditDoc(session.user.id, session.user.role, id);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Lineage is the ydoc row's own created_at, not Doc.createdAt — the two
  // coincide at ordinary creation time but only the former tracks a
  // structurally new document, which is the only thing lineage exists to
  // detect (PLAN.md §11e).
  const documentName = ydocIdForDoc(id);
  const ydocRow = await prisma.ydoc.findUnique({ where: { id: documentName }, select: { createdAt: true } });
  if (!ydocRow) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const token = await signYdocToken({ sub: session.user.id, documentName, role: session.user.role });
  return NextResponse.json({ token, lineage: ydocRow.createdAt.getTime(), documentName });
}
