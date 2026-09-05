import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { gated, titleWhenOk } from "@/lib/route-access";
import { canManageDocs, canEditAnySharedDoc } from "@/lib/doc-authz";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { MarginNotesProvider } from "@/components/margin-notes/margin-notes-context";
import { EDITOR_MARGIN_NOTES_MEDIA_QUERY } from "@/lib/margin-notes-layout";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import DocEditor from "@/components/DocEditor";
import { docTitleOrFallback } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";

// resolveDocParam rather than a direct query — the id-or-slug ambiguity this
// route shares with /doc/[slug] and /doc/[slug]/slug (PLAN.md §12f). No
// deletedByUserId check, unlike the reading route: a soft-deleted doc must
// still load here so the Settings panel can offer Undelete.
//
// The rule canUserEditDoc states (src/lib/doc-authz.ts), stated inline against
// the visibility and authors already loaded rather than through a second
// query: ADMIN/EDITOR edit any SHARED doc, and a PRIVATE doc is editable by
// its listed authors alone (docs/PERMISSIONS.md). /docs' "Show all docs"
// checkbox belongs to that listing and carries no weight here.
const loadDocForEdit = gated(async (user, slug: string) => {
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
    return "not-found";
  }
  const isOwner = doc.authors.some((a) => a.userId === user.id);
  const canEditShared = doc.visibility === "SHARED" && canEditAnySharedDoc(user.role);
  if (!canEditShared && (!canManageDocs(user.role) || !isOwner)) {
    return "forbidden";
  }
  return doc;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadDocForEdit(slug), (doc) => `✎ ${docTitleOrFallback(doc.title)}`);
}

export default async function EditDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadDocForEdit(slug);
  if (access.status === "signed-out") {
    redirect(signInPath(`/doc/${slug}/edit`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this doc.</p>
      </main>
    );
  }
  const { value: doc, user } = access;

  const [eligibleUsers, threads] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ["ADMIN", "EDITOR", "AUTHOR"] } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    }),
    getDocAnnotationsAsThreads(doc.id),
  ]);

  // "focus mode" pulls all annotations rather than just anchored ones and we
  // don't know whether we're in it at this point
  const annotations = buildAnnotationEntries(threads);

  return (
    // AnnotationMoveProvider: required by AnnotationPopover's own
    // useAnnotationMove() call, even though DocEditor always passes it
    // allowMoveToBottom={false} — there is no bottom composer on this page
    // for a draft to move to, but the hook throws outside a provider
    // regardless of whether that path is ever reached.
    // DocPresenceProvider: PLAN.md §13i's presence channel, fed
    // provider.awareness by DocEditor itself here (the reading view instead
    // feeds it its own read-only tap) — same channel either way.
    <DocPresenceProvider>
      <AnnotationMoveProvider>
        {/* The one surface that overrides the rail's threshold: on a phone
            in landscape the rail engages where 1180px alone would refuse
            (EDITOR_MARGIN_NOTES_MEDIA_QUERY). */}
        <MarginNotesProvider query={EDITOR_MARGIN_NOTES_MEDIA_QUERY}>
          <DocEditor
            docId={doc.id}
            slug={doc.slug}
            initialTitle={doc.title}
            visibility={doc.visibility}
            createdAt={doc.createdAt}
            userId={user.id}
            userName={user.name ?? user.email ?? "Anonymous"}
            userColor={user.color}
            authorIds={doc.authors.map((a) => a.userId)}
            eligibleUsers={eligibleUsers}
            initialDeleted={doc.deletedByUserId !== null}
            annotations={annotations}
          />
        </MarginNotesProvider>
      </AnnotationMoveProvider>
    </DocPresenceProvider>
  );
}
