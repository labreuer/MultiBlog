import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { snapshotYdoc } from "@/lib/ydoc-admin";

// Proxies /ydoc-debug's Snapshot button to the running collab server — a
// snapshot has to be taken there, not from the stored blob here, because the
// blob is debounce-stale relative to the update log (PLAN.md §11d).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdmin(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const exists = await prisma.ydoc.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    await snapshotYdoc({ documentName: id, userId: session.user.id, role: session.user.role });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to snapshot." }, { status: 502 });
  }

  return new NextResponse(null, { status: 204 });
}
