import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { canEditAnyPost } from "@/lib/authz";
import DocEditor from "@/components/DocEditor";

export default async function EditDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  // resolveDocParam rather than a direct query — the id-or-slug ambiguity
  // this route shares with /doc/[slug] and /doc/[slug]/live-history
  // (PLAN.md §12f).
  const doc = await resolveDocParam(slug, {
    id: true,
    title: true,
    visibility: true,
    createdAt: true,
    deletedByUserId: true,
    authors: { select: { userId: true }, orderBy: { bylineOrder: "asc" } },
  });
  if (!doc) {
    notFound();
  }

  const isOwner = doc.authors.some((a) => a.userId === session.user.id);
  if (!canEditAnyPost(session.user.role) && !isOwner) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this doc.</p>
      </main>
    );
  }

  const eligibleUsers = await prisma.user.findMany({
    where: { role: { in: ["ADMIN", "EDITOR", "AUTHOR"] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });

  return (
    <DocEditor
      docId={doc.id}
      initialTitle={doc.title}
      visibility={doc.visibility}
      createdAt={doc.createdAt}
      userId={session.user.id}
      userName={session.user.name ?? session.user.email ?? "Anonymous"}
      userColor={session.user.color}
      authorIds={doc.authors.map((a) => a.userId)}
      eligibleUsers={eligibleUsers}
      initialDeleted={doc.deletedByUserId !== null}
    />
  );
}
