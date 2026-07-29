import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { signYdocToken } from "@/lib/ydoc-token";

// Mints a short-lived ydoc token for /ydoc-debug's editor, and hands back the
// document's lineage (its ydoc.created_at, epoch ms) so the client can key
// its IndexedDB store correctly *before* connecting — see PLAN.md §11e for
// why that ordering matters (a stale-lineage local copy must never get the
// chance to merge into a re-seeded document).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const row = await prisma.ydoc.findUnique({ where: { id }, select: { createdAt: true } });
  if (!row) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const token = await signYdocToken({ sub: session.user.id, documentName: id, role: session.user.role });
  return NextResponse.json({ token, lineage: row.createdAt.getTime() });
}
