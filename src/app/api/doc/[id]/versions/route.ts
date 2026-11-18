import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserSeeDocHistory } from "@/lib/doc-authz";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import type { VersionIndex } from "@/lib/diff-slider";

// docs/FORKS.md "Sliders on the diff page" — a doc's index: its update ids
// and their times, oldest first, which is all a slider on the diff page needs
// to name a version. The replay route beside this one sends every update's
// bytes; this sends none.
//
// **The gate is asked before anything else is read**, and a viewer it refuses
// gets one answer whatever the id: canUserSeeDocHistory is false for a doc
// that is missing or deleted as it is for one whose history isn't theirs. So
// nothing here tells a reader without the history anything about the log, its
// length included. Never canUserSeeDocVersion: a parent shown through the
// fork-point exception is one version, and has no index to give.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!(await canUserSeeDocHistory(session.user.id, session.user.role, id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.ydocUpdate.findMany({
    where: { ydocId: ydocIdForDoc(id) },
    orderBy: { id: "asc" },
    select: { id: true, createdAt: true },
  });
  const updates: VersionIndex = rows.map((row) => ({ id: row.id.toString(), createdAt: row.createdAt.toISOString() }));
  return NextResponse.json({ updates });
}
