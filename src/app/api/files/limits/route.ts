import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canManageFiles } from "@/lib/role-checks";
import { maxUploadBytes } from "@/lib/file-storage";
import type { FileLimits } from "@/lib/file-format";

// PLAN.md §19 — what the server will actually accept, so the upload control can
// refuse an over-sized file *before* sending a single byte.
//
// This exists because FILE_MAX_UPLOAD_BYTES is a bare env var, deliberately not
// NEXT_PUBLIC_: a deployment changes its limit with a restart rather than a
// rebuild, which a NEXT_PUBLIC_ value baked into the client bundle could not
// do. The consequence is that the browser has to be *told* the number, and
// asking is the only way the client-side pre-check and the server-side
// enforcement are provably the same value instead of two constants that drift.
//
// Gated rather than public: it says something (small) about how this deployment
// is configured, and only someone who can upload has any use for it.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageFiles(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limits: FileLimits = { maxUploadBytes: maxUploadBytes() };
  return NextResponse.json(limits);
}
