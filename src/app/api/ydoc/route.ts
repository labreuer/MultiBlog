import { NextResponse } from "next/server";
import * as Y from "yjs";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { newYdocId } from "@/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../../../../server/ydoc-store";

// Admin-only surface for the /ydoc-debug page (PLAN.md §11f) — lists and
// creates standalone ydoc-stack documents. Never touched by post editing.

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.ydoc.findMany({
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json({
    ydocs: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const id = newYdocId();
  const emptyDoc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(emptyDoc);
  emptyDoc.destroy();

  await ydocStore.createIfAbsent(id, ydoc, stateVector);

  return NextResponse.json({ id }, { status: 201 });
}
