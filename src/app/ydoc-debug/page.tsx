import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { signInPath } from "@/lib/sign-in-redirect";
import YdocDebug from "@/components/YdocDebug";

export const metadata: Metadata = { title: "Ydoc debug" };

// Admin-only inspector for the ydoc stack (PLAN.md §11f): it reads any
// document, a PRIVATE doc's included, and writes none, since inspecting the
// stack is its whole job. Same ADMIN-gate shape as /site-settings.
//
// It lists the ten most recently updated ydocs, which a busy server can push
// any one document out of, so `?id=` opens one directly.
export default async function YdocDebugPage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const { id } = await searchParams;
  const requested = typeof id === "string" && id ? id : null;
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(requested ? `/ydoc-debug?id=${encodeURIComponent(requested)}` : "/ydoc-debug"));
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Ydoc debug</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const select = { id: true, createdAt: true, updatedAt: true } as const;
  const recent = await prisma.ydoc.findMany({ orderBy: { updatedAt: "desc" }, take: 10, select });
  const named =
    requested && !recent.some((doc) => doc.id === requested)
      ? await prisma.ydoc.findUnique({ where: { id: requested }, select })
      : null;
  const initialDocs = named ? [named, ...recent] : recent;

  return (
    <YdocDebug
      initialDocs={initialDocs.map((doc) => ({
        id: doc.id,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      }))}
      initialSelectedId={requested && initialDocs.some((doc) => doc.id === requested) ? requested : null}
    />
  );
}
