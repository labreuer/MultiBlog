import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// Everything /ydoc-debug's replay slider needs, in one shot: every raw update
// and every snapshot blob for a document (PLAN.md §11f). Deliberately separate
// from GET /api/ydoc/[id], which backs the Refresh tables and is re-fetched on
// every Refresh click — folding the payloads in there would re-download the
// whole log each time.
//
// The slider prefetches all of this once so that a scrub step touches no
// network at all, which is what makes its reported millisecond figure a clean
// read on replay CPU cost rather than a mix of CPU and fetch latency. That
// trade is deliberate and specific to this page: it ships the entire log to
// measure the cost of *not* replaying all of it.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const doc = await prisma.ydoc.findUnique({ where: { id }, select: { id: true } });
  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const [updates, snapshots] = await Promise.all([
    prisma.ydocUpdate.findMany({
      where: { ydocId: id },
      orderBy: { id: "asc" },
      select: { id: true, createdAt: true, update: true },
    }),
    // Ascending by high-water mark, so the client can scan for "newest
    // snapshot at or below this position" without re-sorting.
    prisma.ydocSnapshot.findMany({
      where: { ydocId: id },
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
