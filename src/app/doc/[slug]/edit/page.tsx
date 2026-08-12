import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { canManageDocs, canEditAnySharedDoc } from "@/lib/doc-authz";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { MarginNotesProvider } from "@/components/margin-notes/margin-notes-context";
import DocEditor from "@/components/DocEditor";

export default async function EditDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  // resolveDocParam rather than a direct query — the id-or-slug ambiguity
  // this route shares with /doc/[slug] and /doc/[slug]/slug (PLAN.md §12f).
  const doc = await resolveDocParam(slug, {
    id: true,
    slug: true,
    title: true,
    visibility: true,
    createdAt: true,
    deletedByUserId: true,
    authors: { select: { userId: true }, orderBy: { bylineOrder: "asc" } },
  });
  if (!doc) {
    notFound();
  }

  // The rule canUserEditDoc states (src/lib/doc-authz.ts), evaluated against
  // the visibility and authors this page has already loaded rather than
  // through a second query: ADMIN/EDITOR edit any SHARED doc, and a PRIVATE
  // doc is editable by its listed authors alone (docs/PERMISSIONS.md). /docs' "Show
  // all docs" checkbox belongs to that listing and carries no weight here.
  const isOwner = doc.authors.some((a) => a.userId === session.user.id);
  const canEditShared = doc.visibility === "SHARED" && canEditAnySharedDoc(session.user.role);
  if (!canEditShared && (!canManageDocs(session.user.role) || !isOwner)) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this doc.</p>
      </main>
    );
  }

  const [eligibleUsers, threads] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["ADMIN", "EDITOR", "AUTHOR"] } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    getDocAnnotationsAsThreads(doc.id),
  ]);

  // PLAN.md §18c — the editing view shows presently-anchored annotations
  // beside the text and nothing else, so the general-discussion threads are
  // dropped here rather than shipped and then hidden. This is a cheap
  // pre-filter on a store-debounce snapshot, not the decision: which marks
  // actually exist is re-resolved against the live document on every
  // measurement (EditorAnnotationRail), which is the only answer that stays
  // true while someone is typing.
  const annotations = buildAnnotationEntries(threads).filter((entry) => entry.quotedText !== "");

  return (
    <MarginNotesProvider>
      <DocEditor
        docId={doc.id}
        slug={doc.slug}
        initialTitle={doc.title}
        visibility={doc.visibility}
        createdAt={doc.createdAt}
        userId={session.user.id}
        userName={session.user.name ?? session.user.email ?? "Anonymous"}
        userColor={session.user.color}
        authorIds={doc.authors.map((a) => a.userId)}
        eligibleUsers={eligibleUsers}
        initialDeleted={doc.deletedByUserId !== null}
        annotations={annotations}
      />
    </MarginNotesProvider>
  );
}
