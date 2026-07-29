import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditDoc } from "@/lib/doc-authz";
import { ydocIdForDoc } from "@/lib/ydoc-names";

// Doc-scoped sibling of /api/ydoc/[id]/replay (that route stays ADMIN-gated
// and /ydoc-debug-only) — identically shaped response, consumed by
// DocScrubBar.tsx's embedded scrub bar on /doc/[slug] (PLAN.md §12a/§12n).
// Gated on canUserEditDoc rather than isAdmin: a doc's own AUTHOR should see
// its history without being an admin.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const doc = await prisma.doc.findUnique({ where: { id }, select: { id: true } });
  if (!doc) {
    return NextResponse.json({ error: "Doc not found" }, { status: 404 });
  }
  if (!(await canUserEditDoc(session.user.id, session.user.role, id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const documentName = ydocIdForDoc(id);
  const [updates, snapshots] = await Promise.all([
    prisma.ydocUpdate.findMany({
      where: { ydocId: documentName },
      orderBy: { id: "asc" },
      select: { id: true, createdAt: true, update: true },
    }),
    // §12m: docs have no ydoc_snapshot rows yet (checkpointing is
    // deferred), so this always comes back empty for a doc — every
    // rebuild falls back to row #1, same as /ydoc-debug before its first
    // Snapshot button press. Queried anyway so ReplayView needs no
    // doc-vs-/ydoc-debug branch at all.
    prisma.ydocSnapshot.findMany({
      where: { ydocId: documentName },
      orderBy: { lastYdocUpdateId: "asc" },
      select: { id: true, createdAt: true, lastYdocUpdateId: true, ydoc: true },
    }),
  ]);

  return NextResponse.json({
    updates: updates.map((u) => ({
      id: u.id.toString(),
      createdAt: u.createdAt.toISOString(),
      base64: Buffer.from(u.update).toString("base64"),
    })),
    snapshots: snapshots.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastYdocUpdateId: s.lastYdocUpdateId.toString(),
      base64: Buffer.from(s.ydoc).toString("base64"),
    })),
  });
}
