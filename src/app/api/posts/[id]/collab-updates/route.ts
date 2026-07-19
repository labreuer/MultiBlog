import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";

// The persisted "since last revision" Yjs update log for a post — seeds the
// live-history scrubber's replay list. New updates after the page loads
// arrive over the live collab connection instead (see LiveHistoryViewer).
// The first row is always the session's starting state (see onLoadDocument
// in server/collab.ts), so replaying from row 0 is always self-sufficient.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: postId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allowed = await canUserEditPost(session.user.id, session.user.role, postId);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.postCollabUpdate.findMany({
    where: { postId },
    orderBy: { id: "asc" },
    select: { id: true, createdAt: true, update: true },
  });

  return NextResponse.json({
    updates: rows.map((row) => ({
      id: row.id.toString(),
      ts: row.createdAt.getTime(),
      update: Buffer.from(row.update).toString("base64"),
    })),
  });
}
