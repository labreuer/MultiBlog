import type { Actor } from "@/lib/actor";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { displayNameOf } from "@/lib/display-name";
import { readableDocsWhere } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { firstPage, isPageLocator, normalizeLocator, pdfPageHref } from "@/lib/entity-chips/kinds/citation";
import { readableFilesWhere } from "@/lib/file-authz";
import { pdfMetadata } from "@/lib/pdf-metadata";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { referenceByKey } from "@/lib/reference-data";
import { parseReferenceSegment, referencePath } from "@/lib/references/keys";
import { placeCitedQuotation, placedFragment } from "@/lib/cited-passage";
import { parseCitedQuery } from "@/lib/cited-passage-query";
import { formatPassageText } from "@/lib/pdf-fragment";
import { FragmentChecker } from "@/lib/pdf-fragment-check";
import { withoutBrackets } from "@/lib/pdf-passage-pieces";
import { fileVersionState, latestVersionOf, pageStampFor, pdfNoteContainer } from "@/lib/file-version";
import { referentTarget } from "@/lib/pdf-link-reading";
import type { PageStamp } from "@/lib/pdf-open-params";
import { noteVersions } from "@/lib/file-version-data";

// docs/CITATIONS.md, "Pages" — what a reference's public page can't show
// everyone: the docs and notes citing the work, and the work's PDF, for one
// viewer. Each list goes through its own read rule, as search's do, and the
// citations are found by identity in the trigger-kept `citation` table.
//
// Server-only. The page's client island asks for it through
// `referenceCitedBy` in src/app/actions/references.ts. `citedPageTarget` is
// the same question asked when a citation's link is followed.

/** How many of each are listed; the page is a pointer, and search lists the rest (`cites=`). */
export const CITED_BY_LIMIT = 20;

export type ReferenceCitedBy = {
  docs: { title: string; href: string }[];
  /** Each note by its writer and the doc or PDF it is on, linked to its card. */
  notes: { writer: string; on: string; href: string }[];
  /** Whether either list was cut at `CITED_BY_LIMIT`. */
  more: boolean;
  /** The work's PDF, where this viewer may read it, with each sheet's printed label, its page count and its stamp for a link to a page: the latest version's. */
  file: { title: string; slug: string; pageLabels: string[] | null; pageCount: number | null; stamp: PageStamp } | null;
};

const NOTHING: ReferenceCitedBy = { docs: [], notes: [], more: false, file: null };

/** A file's printed page labels, as stored: one string per sheet, or null. */
function pageLabelsOf(stored: unknown): string[] | null {
  return Array.isArray(stored) && stored.every((label) => typeof label === "string") ? (stored as string[]) : null;
}

/**
 * Where a citation's link to page `page` of the work with key `key` sends
 * this viewer (docs/CITATIONS.md, "The link"): the PDF at that page when the
 * reference has one they may read and its page labels name the page, and
 * the reference's page otherwise, the page in its fragment for its island.
 * null when no reference has or had the key, and for a list, which is no
 * one work. `segment` is read as the page reads it, so `~<alias>` is the
 * alias (docs/CITATIONS.md, "The page").
 *
 * `query` is the link's raw query (src/lib/cited-passage-query.ts). A
 * `/pdf/` referent's page and `text` pairs are a link into the work's file,
 * read as the viewer reads one on the bare address (`referentTarget`). A
 * quotation is placed on the cited page, and on the pages after it
 * that a locator of several pages names, from the stored page text
 * (`placeCitedQuotation`): its brackets settled, split where a page breaks,
 * each piece in the writer's form with its own page. A quotation the page
 * doesn't hold goes as it is, its brackets' letters kept, so the viewer says
 * it isn't there and looks for it elsewhere (docs/PDF_FRAGMENT_LINKS.md §6).
 *
 * Nothing about the PDF reaches a viewer who may not read it: their answer
 * is the one a reference with no PDF gives, whatever the query.
 */
export async function citedPageTarget(actor: Actor | null, segment: string, page: string, query = ""): Promise<string | null> {
  // Shape first, as the reference's page checks it: a key that can't be one costs no query.
  const parsed = parseReferenceSegment(segment);
  if (!parsed || parsed.kind === "list") return null;
  const reference = await referenceByKey(parsed.key);
  if (!reference) return null;
  const home = referencePath(reference.key);
  if (!isPageLocator(page)) return home;
  const first = firstPage(normalizeLocator(page));
  const fallback = `${home}#p=${encodeURIComponent(first)}`;
  const filesWhere = actor ? readableFilesWhere(actor.userId, actor.role) : null;
  if (!reference.fileId || reference.deleted || !filesWhere) return fallback;
  const file = await prisma.storedFile.findFirst({
    where: { AND: [filesWhere, { id: reference.fileId }] },
    select: {
      id: true,
      slug: true,
      currentVersionId: true,
      currentVersion: { select: { id: true, number: true, pageLabels: true, pageCount: true } },
      versions: { select: { id: true, number: true, promotedAt: true, abandonedAt: true } },
    },
  });
  if (!file) return fallback;
  // A citation's page is resolved on the latest version's labels and text at
  // every click (docs/PDF.md §13, "Links into the file").
  const latest = latestVersionOf(file);
  // A version whose labels haven't been read yet (NULL) has them read and
  // stored now, as every reader of them does (src/lib/pdf-metadata.ts), so
  // its first citation lands on the page the labels name and not on the sheet
  // of that number.
  const pageLabels = pageLabelsOf(latest.pageLabels) ?? (await pdfMetadata(latest.id))?.pageLabels ?? null;
  // Every link below is stamped with the latest version once the file has a second.
  const stamp = pageStampFor(latest.number, file.versions.length);
  const pageHref = pdfPageHref({ slug: file.slug, pageLabels, pageCount: latest.pageCount, stamp }, first);
  if (!pageHref || latest.pageCount === null) return fallback;

  const asked = parseCitedQuery(query);
  if (asked.kind === "pairs") {
    const versions = file.versions.map((version) => ({ number: version.number, state: fileVersionState(version, file.currentVersionId) }));
    return referentTarget(file.slug, asked.fragment, latest.number, versions) ?? pageHref;
  }
  if (asked.kind !== "quotation") return pageHref;
  const { placed, pages } = await placeCitedQuotation(new FragmentChecker(), { id: file.id, pageCount: latest.pageCount, ownLabels: pageLabels }, page, asked.text);
  if (placed && pages) return `/pdf/${file.slug}#${placedFragment(placed, pages)}`;
  // `pageHref` ends in its page with its stamp, so the passage follows both.
  return `${pageHref}&text=${formatPassageText(withoutBrackets(asked.text))}`;
}

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
            id: true,
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
      ? prisma.storedFile.findFirst({
          where: { AND: [filesWhere, { id: reference.fileId }] },
          select: { slug: true, title: true, currentVersion: { select: { number: true, pageLabels: true, pageCount: true } }, _count: { select: { versions: true } } },
        })
      : null,
  ]);

  // A note on a PDF is linked at the version it is on, and names it where
  // that is not the latest (docs/PDF.md §13, "Addresses").
  const versionOf = await noteVersions(notes.flatMap((note) => (note.file ? [note.id] : [])));
  return {
    docs: docs.slice(0, CITED_BY_LIMIT).map((doc) => ({ title: docTitleOrFallback(doc.title), href: `/doc/${doc.slug}` })),
    notes: notes.slice(0, CITED_BY_LIMIT).flatMap((note) => {
      const pdf = note.file ? pdfNoteContainer(note.file, versionOf.get(note.id)) : null;
      const container = note.doc
        ? { href: `/doc/${note.doc.slug}`, title: docTitleOrFallback(note.doc.title) }
        : pdf
          ? { href: pdf.path, title: pdf.title }
          : null;
      if (!container) return [];
      // The name its card shows, which is what the card's permalink is built from.
      const writer = displayNameOf(note.user);
      return [{ writer, on: container.title, href: `${container.href}#${annotationAnchorName(writer, note.createdAt)}` }];
    }),
    more: docs.length > CITED_BY_LIMIT || notes.length > CITED_BY_LIMIT,
    file: file
      ? {
          title: file.title,
          slug: file.slug,
          pageLabels: pageLabelsOf(latestVersionOf(file).pageLabels),
          pageCount: latestVersionOf(file).pageCount,
          stamp: pageStampFor(latestVersionOf(file).number, file._count.versions),
        }
      : null,
  };
}
