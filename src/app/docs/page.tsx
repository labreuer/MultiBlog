import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canManageDocs } from "@/lib/doc-authz";
import { canEditAnyPost } from "@/lib/authz";
import DocsTable from "@/components/DocsTable";

export default async function DocsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Docs</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage docs.</p>
      </main>
    );
  }

  const docs = await prismaIncludingDeleted.doc.findMany({
    where: canEditAnyPost(session.user.role) ? undefined : { authors: { some: { userId: session.user.id } } },
    orderBy: { createdAt: "desc" },
    include: {
      authors: {
        orderBy: { bylineOrder: "asc" },
        select: { user: { select: { adminInitials: true } } },
      },
    },
  });

  const rows = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    authors: doc.authors.map((a) => a.user.adminInitials).join(", "),
    visibility: doc.visibility,
    createdAt: doc.createdAt,
    deleted: doc.deletedByUserId !== null,
  }));

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Docs</h1>
      <p>
        <Link href="/docs/new">+ New doc</Link>
      </p>
      <DocsTable rows={rows} />
    </main>
  );
}
