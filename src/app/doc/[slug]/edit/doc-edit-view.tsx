import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canEditDocRow } from "@/lib/doc-authz";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { MarginNotesProvider } from "@/components/margin-notes/margin-notes-context";
import { EDITOR_MARGIN_NOTES_MEDIA_QUERY } from "@/lib/margin-notes-layout";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import DocEditor from "@/components/DocEditor";
import { ChipSurfaceProvider } from "@/lib/entity-chips/chip-surface";
import { displayNameOf, staffDisplayNameOf } from "@/lib/display-name";
import { wikiAddressOfDoc } from "@/lib/wiki-address";
import { wikiAddressHistoriesOf } from "@/lib/wiki-rename";
import { isFrontPageAddress } from "@/lib/front-page";

// The editor over a doc already resolved and gated: what /doc/[slug]/edit
// renders, and what a wiki page's `/edit` renders (docs/WIKI.md "The doc view
// at an address"). Each route keeps its own resolver and gate
// (src/lib/route-access.ts: the envelope is shared, never the gate).

export const DOC_EDIT_SELECT = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  wikiName: true,
  wikiVariant: true,
  wikiOwnerUserId: true,
  wikiOwner: { select: { slug: true } },
  createdAt: true,
  deletedByUserId: true,
  authors: { select: { userId: true }, orderBy: { bylineOrder: "asc" } },
} as const;

export type DocForEditing = Prisma.DocGetPayload<{ select: typeof DOC_EDIT_SELECT }>;

/**
 * canEditDocRow (src/lib/doc-authz.ts), asked of the row the editor already
 * loaded rather than through a second query: ADMIN/EDITOR edit any SHARED or
 * PUBLIC doc but a person's wiki page, and a PRIVATE doc is editable by its
 * listed authors alone (docs/PERMISSIONS.md). /docs' "Show all docs" checkbox
 * belongs to that listing and carries no weight here.
 */
export function canEditLoadedDoc(doc: DocForEditing, user: Session["user"]): boolean {
  const isAuthor = doc.authors.some((a) => a.userId === user.id);
  return canEditDocRow({ visibility: doc.visibility, wikiOwnerUserId: doc.wikiOwnerUserId, isAuthor }, user.role);
}

export default async function DocEditView({ doc, user }: { doc: DocForEditing; user: Session["user"] }) {
  const [eligibleUsers, threads, addressHistories, frontPage] = await Promise.all([
    prisma.user
      .findMany({
        where: { role: { in: ["ADMIN", "EDITOR", "AUTHOR"] } },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: "asc" },
      })
      .then((users) => users.map((u) => ({ id: u.id, role: u.role, label: staffDisplayNameOf(u, user.role) }))),
    getDocAnnotationsAsThreads(doc.id),
    // The doc's past wiki addresses, which Delete lists before deleting them
    // with it (docs/WIKI.md "Deleting a page"); a doc moved out of the wiki
    // can have some too.
    wikiAddressHistoriesOf([doc.id], (u) => staffDisplayNameOf(u, user.role)),
    // Whether this is the commons' Front Page, the landing page's preamble
    // when PUBLIC, which the name field and Settings say (docs/WIKI.md "The
    // front page"); the name is matched by its key, which only the database folds.
    doc.wikiName !== null && doc.wikiOwnerUserId === null && doc.wikiVariant === "" ? isFrontPageAddress(doc.id) : false,
  ]);

  // "focus mode" pulls all annotations rather than just anchored ones and we
  // don't know whether we're in it at this point
  const annotations = await buildAnnotationEntries(threads);
  const address = wikiAddressOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null });

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
          {/* Names the doc for its editors' entity chips (docs/ENTITY_CHIPS.md). */}
          <ChipSurfaceProvider doc={doc.id}>
            <DocEditor
              docId={doc.id}
              slug={doc.slug}
              initialTitle={doc.title}
              visibility={doc.visibility}
              wiki={address && { address, ownerUserId: doc.wikiOwnerUserId, frontPage }}
              addressHistory={addressHistories.get(doc.id) ?? []}
              createdAt={doc.createdAt}
              userId={user.id}
              userName={displayNameOf(user)}
              userColor={user.color}
              userInitials={user.adminInitials}
              authorIds={doc.authors.map((a) => a.userId)}
              eligibleUsers={eligibleUsers}
              initialDeleted={doc.deletedByUserId !== null}
              annotations={annotations}
            />
          </ChipSurfaceProvider>
        </MarginNotesProvider>
      </AnnotationMoveProvider>
    </DocPresenceProvider>
  );
}
