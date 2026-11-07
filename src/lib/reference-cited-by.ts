import type { Actor } from "@/lib/actor";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { displayNameOf } from "@/lib/display-name";
import { readableDocsWhere } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { readableFilesWhere } from "@/lib/file-authz";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";

// docs/CITATIONS.md, "Pages" — what a reference's public page can't show
// everyone: the docs and notes citing the work, and the work's PDF, for one
// viewer. Each list goes through its own read rule, as search's do, and the
// citations are found by identity in the trigger-kept `citation` table.
//
// Server-only. The page's client island asks for it through
// `referenceCitedBy` in src/app/actions/references.ts.

/** How many of each are listed; the page is a pointer, and search lists the rest (`cites=`). */
export const CITED_BY_LIMIT = 20;

export type ReferenceCitedBy = {
  docs: { title: string; href: string }[];
  /** Each note by its writer and the doc or PDF it is on, linked to its card. */
  notes: { writer: string; on: string; href: string }[];
  /** Whether either list was cut at `CITED_BY_LIMIT`. */
  more: boolean;
  /** The work's PDF, where this viewer may read it, with each sheet's printed label for a link to a page. */
  file: { title: string; slug: string; pageLabels: string[] | null } | null;
};

const NOTHING: ReferenceCitedBy = { docs: [], notes: [], more: false, file: null };

export async function referenceCitedBy(actor: Actor, referenceId: string): Promise<ReferenceCitedBy> {
  // Deleted references included: a removed work's page still says where it was cited.
  const reference = await prismaIncludingDeleted.reference.findUnique({ where: { id: referenceId }, select: { fileId: true } });
  if (!reference) return NOTHING;
  const cites = { citations: { some: { referenceId } } };

  const docsWhere = readableDocsWhere(actor.userId, actor.role);
  const notesWhere = readableAnnotationsWhere(actor.userId, actor.role);
  const filesWhere = readableFilesWhere(actor.userId, actor.role);
  const [docs, notes, file] = await Promise.all([
    docsWhere
      ? prisma.doc.findMany({
          where: { AND: [docsWhere, cites] },
          select: { slug: true, title: true },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          take: CITED_BY_LIMIT + 1,
        })
      : [],
    notesWhere
      ? prisma.annotation.findMany({
          where: { AND: [notesWhere, cites] },
          select: {
            createdAt: true,
            user: { select: { name: true, slug: true } },
            doc: { select: { slug: true, title: true } },
            file: { select: { slug: true, title: true } },
          },
          orderBy: [{ postedAt: "desc" }, { id: "desc" }],
          take: CITED_BY_LIMIT + 1,
        })
      : [],
    reference.fileId && filesWhere
      ? prisma.storedFile.findFirst({ where: { AND: [filesWhere, { id: reference.fileId }] }, select: { slug: true, title: true, pageLabels: true } })
      : null,
  ]);

  const labels = file?.pageLabels;
  return {
    docs: docs.slice(0, CITED_BY_LIMIT).map((doc) => ({ title: docTitleOrFallback(doc.title), href: `/doc/${doc.slug}` })),
    notes: notes.slice(0, CITED_BY_LIMIT).flatMap((note) => {
      const container = note.doc
        ? { href: `/doc/${note.doc.slug}`, title: docTitleOrFallback(note.doc.title) }
        : note.file
          ? { href: `/pdf/${note.file.slug}`, title: note.file.title }
          : null;
      if (!container) return [];
      // The name its card shows, which is what the card's permalink is built from.
      const writer = displayNameOf(note.user);
      return [{ writer, on: container.title, href: `${container.href}#${annotationAnchorName(writer, note.createdAt)}` }];
    }),
    more: docs.length > CITED_BY_LIMIT || notes.length > CITED_BY_LIMIT,
    file: file
      ? { title: file.title, slug: file.slug, pageLabels: Array.isArray(labels) && labels.every((l) => typeof l === "string") ? (labels as string[]) : null }
      : null,
  };
}
