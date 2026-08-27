import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import YdocDebug from "@/components/YdocDebug";

export const metadata: Metadata = { title: "Ydoc debug" };

// Admin-only proving ground for the standalone ydoc persistence stack
// (PLAN.md §11) — deliberately separate from every post-editing surface, so
// nothing here can regress post editing and nothing in post editing can
// regress this. Same ADMIN-gate shape as /site-settings.
export default async function YdocDebugPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Ydoc debug</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const initialDocs = await prisma.ydoc.findMany({
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, createdAt: true, updatedAt: true },
  });

  return (
    <YdocDebug
      initialDocs={initialDocs.map((doc) => ({
        id: doc.id,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      }))}
      userId={session.user.id}
      userName={session.user.name ?? session.user.email ?? "Anonymous"}
      userColor={session.user.color}
    />
  );
}
