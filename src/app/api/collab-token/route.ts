import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";
import { signCollabToken } from "@/lib/collab-token";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const postId = body?.postId;
  if (typeof postId !== "string" || !postId) {
    return NextResponse.json({ error: "postId is required" }, { status: 400 });
  }

  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) {
    return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }

  const allowed = await canUserEditPost(session.user.id, session.user.role, postId);
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = await signCollabToken({ sub: session.user.id, postId, role: session.user.role });
  return NextResponse.json({ token });
}
