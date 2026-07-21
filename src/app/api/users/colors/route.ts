import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Looks up display name + color for a set of user ids — used to render
// author-highlight marks (which only store an authorId) and collab carets.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const idsParam = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = Array.from(new Set(idsParam.split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 100);
  if (ids.length === 0) {
    return NextResponse.json({});
  }

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true, color: true },
  });

  const result: Record<string, { name: string; color: string }> = {};
  for (const user of users) {
    result[user.id] = { name: user.name ?? user.email, color: user.color };
  }
  return NextResponse.json(result);
}
