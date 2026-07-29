import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// Powers both /ydoc-debug panels in one call: the single `ydoc` row, and the
// Refresh section's ydoc_update count/last-10 and every ydoc_snapshot row
// (PLAN.md §11f). BigInt update/snapshot ids are stringified — JSON has no
// BigInt representation.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const [row, updateCount, lastUpdates, snapshots] = await Promise.all([
    prisma.ydoc.findUnique({ where: { id } }),
    prisma.ydocUpdate.count({ where: { ydocId: id } }),
    prisma.ydocUpdate.findMany({
      where: { ydocId: id },
      orderBy: { id: "desc" },
      take: 10,
      select: { id: true, createdAt: true, update: true },
    }),
    prisma.ydocSnapshot.findMany({
      where: { ydocId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, lastYdocUpdateId: true, userId: true, ydoc: true },
    }),
  ]);

  if (!row) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json({
    ydoc: {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ydocBase64: Buffer.from(row.ydoc).toString("base64"),
      byteLength: row.ydoc.length,
      stateVectorLength: row.stateVector.length,
    },
    updateCount,
    lastUpdates: lastUpdates.map((u) => ({
      id: u.id.toString(),
      createdAt: u.createdAt.toISOString(),
      byteLength: u.update.length,
    })),
    snapshots: snapshots.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastYdocUpdateId: s.lastYdocUpdateId.toString(),
      userId: s.userId,
      byteLength: s.ydoc.length,
    })),
  });
}
