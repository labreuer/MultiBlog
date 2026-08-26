import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { canManageDocs, canEditAnySharedDoc } from "@/lib/doc-authz";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { MarginNotesProvider } from "@/components/margin-notes/margin-notes-context";
import { EDITOR_MARGIN_NOTES_MEDIA_QUERY } from "@/lib/margin-notes-layout";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
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

  // Every thread, anchorless ones included. This used to pre-filter to
  // `quotedText !== ""` on the grounds that the editing view shows
  // presently-anchored annotations and nothing else (PLAN.md §18c) — true of
  // the wide layout, and false of the phone-landscape queue, which lists all
  // of them precisely so an author can see there are twelve rather than the
  // two beside the current viewport.
  //
  // A server component cannot make that choice: which presentation is on
  // screen is a media query. So the filtering moved to the one place that
  // knows — EditorAnnotationRail — and the wide layout drops an anchorless
  // card exactly as before, by the bounded pass finding no position for it
  // (use-margin-notes-layout.ts). Nothing is shipped that isn't wanted by one
  // of the two presentations.
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
            userId={session.user.id}
            userName={session.user.name ?? session.user.email ?? "Anonymous"}
            userColor={session.user.color}
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
