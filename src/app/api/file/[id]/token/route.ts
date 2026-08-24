import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserReadFile } from "@/lib/file-authz";
import { signYdocToken } from "@/lib/ydoc-token";
import { ydocIdForFile } from "@/lib/ydoc-names";
import { ensureFilePresenceYdoc } from "@/lib/file-presence-ydoc";

// PLAN.md §19 Phase 4 — a token for a file's presence channel, the file
// counterpart of /api/doc/[id]/token.
//
// **Every token is readOnly, unconditionally.** Nobody ever writes content to
// this document — there is none to write (see ydocIdForFile's note) — so the
// doc route's writable/read-only split has nothing to decide here. Awareness is
// unaffected by `connectionConfig.readOnly`, which is exactly why an entirely
// read-only connection can still carry presence.
//
// The gate is plain `canUserReadFile`: seeing where other readers are, and
// being seen, is part of reading the file.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const file = await prisma.storedFile.findUnique({
    where: { id },
    select: { id: true, visibility: true, deletedByUserId: true },
  });
  if (!file || file.deletedByUserId !== null) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (!(await canUserReadFile(session.user.id, session.user.role, file))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const documentName = ydocIdForFile(id);
  await ensureFilePresenceYdoc(documentName);

  const token = await signYdocToken({
    sub: session.user.id,
    documentName,
    role: session.user.role,
    readOnly: true,
  });
  return NextResponse.json({ token, documentName, readOnly: true });
}
