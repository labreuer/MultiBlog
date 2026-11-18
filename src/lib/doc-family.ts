import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { canViewDocs, docsWithVisibleHistoryWhere, readableDocsWhere, readableWikiDocsWhere } from "@/lib/doc-authz";
import { diffPath } from "@/lib/diff-side";
import { docTitleOrFallback } from "@/lib/doc-title";
import { DOC_PATH_SELECT, docPagePath } from "@/lib/wiki-address";
import { ydocIdForDoc } from "@/lib/ydoc-names";

// docs/FORKS.md "A doc's family" — the doc this one was forked from and the
// docs forked from it, each as this viewer may see it, with links to
// whichever diffs against this doc they may see; for a wiki page, also the
// other pages with its name (docs/WIKI.md "The family line"). DocFamily.tsx
// renders it under the byline in the doc view, and under the name in a
// PUBLIC page's public render.

/** How many forks, and how many pages of the same name, are listed; past it, the list says there are more and doesn't count them. */
export const FAMILY_LIST_LIMIT = 20;

export type FamilyLink = { label: string; href: string };
export type FamilyEntry = { id: string; title: string; path: string; diffs: FamilyLink[] };

export type DocFamily = {
  /** The parent: named when the viewer may read it, held back but still said otherwise; null for a doc that isn't a fork. */
  parent: { entry: FamilyEntry } | { hidden: true; diffs: FamilyLink[] } | null;
  /** When this doc was forked, for a fork. */
  forkedAt: Date | null;
  forks: FamilyEntry[];
  moreForks: boolean;
  /** Other wiki pages whose name has this page's key, neither its parent nor its forks; empty for a doc that isn't a wiki page. */
  sameName: FamilyEntry[];
  moreSameName: boolean;
};

const ENTRY_SELECT = { id: true, title: true, ...DOC_PATH_SELECT, forkedFromUpdateId: true } as const satisfies Prisma.DocSelect;

/** Each doc's first update, its seed for a fork: the least id in its log, in one query over all of them. */
async function firstUpdates(docIds: string[]): Promise<Map<string, bigint>> {
  if (docIds.length === 0) return new Map();
  const rows = await prisma.ydocUpdate.groupBy({
    by: ["ydocId"],
    where: { ydocId: { in: docIds.map(ydocIdForDoc) } },
    _min: { id: true },
  });
  const byYdoc = new Map(rows.map((row) => [row.ydocId, row._min.id]));
  const firsts = new Map<string, bigint>();
  for (const id of docIds) {
    const first = byYdoc.get(ydocIdForDoc(id));
    if (first !== null && first !== undefined) firsts.set(id, first);
  }
  return firsts;
}

/**
 * The family of `doc` as `viewer` may see it, or null when there is nothing
 * to show. The caller has already checked that the viewer may read `doc`.
 *
 * **Only what the viewer can read is named.** Each query spells out
 * `deletedByUserId: null`, since a relation filter goes around the
 * soft-delete extension. The lists give no count of the rest. A parent the
 * viewer can't read, a deleted one included, is held back, but the doc still
 * says it is a fork: left out, a SHARED fork of a PRIVATE doc would pass its
 * parent's text off as its forker's.
 *
 * **A viewer without canViewDocs**, signed out (null) or a COMMENTER, is the
 * public render's: the parent and forks go through the wiki read rule's
 * `where` (`readableWikiDocsWhere`), so only PUBLIC pages are named, and
 * there are no diff links at all, since every diff needs a sign-in and
 * canViewDocs (docs/WIKI.md "The family line"). A viewer with canViewDocs
 * gets them through `readableDocsWhere`, as any doc's family.
 *
 * **Same name** is a wiki page's alone: the other pages whose `wiki_name_key`
 * is this one's, through the wiki read rule's `where` for any viewer, the
 * commons' first. A fork renamed leaves it and stays among the forks.
 *
 * **The diff links are the ones the diff page would show this viewer**, and
 * the rule is written twice, here and in its gate (`canUserSeeDocVersion`):
 *
 * - how the two differ now, for a reader of both (a parent and a fork, or
 *   two pages of one name);
 * - what the fork changed, the fork from its first update to now, for
 *   whoever may see the fork's history. It is read off the fork alone, so it
 *   stays when the parent is held back;
 * - what the parent changed since, the parent from the fork point to now,
 *   for whoever can read the parent and may see its history or the fork's
 *   (the fork-point exception).
 *
 * Whose history the viewer may see is asked once for every doc listed,
 * through `docsWithVisibleHistoryWhere`, not row by row, and not at all for
 * a viewer without canViewDocs.
 */
export async function loadDocFamily(
  viewer: { id: string; role: Role } | null,
  doc: {
    id: string;
    wikiName: string | null;
    forkedFromDocId: string | null;
    forkedFromUpdateId: bigint | null;
    createdAt: Date;
  },
): Promise<DocFamily | null> {
  const reader = viewer !== null && canViewDocs(viewer.role) ? viewer : null;
  const readable = reader ? readableDocsWhere(reader.id, reader.role) : readableWikiDocsWhere(viewer);
  if (!readable) return null;
  const parentId = doc.forkedFromDocId;
  const [parentRow, forkRows, sameRows] = await Promise.all([
    parentId === null
      ? null
      : prisma.doc.findFirst({ where: { AND: [{ id: parentId, deletedByUserId: null }, readable] }, select: ENTRY_SELECT }),
    prisma.doc.findMany({
      where: { AND: [{ forkedFromDocId: doc.id, deletedByUserId: null }, readable] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: FAMILY_LIST_LIMIT + 1,
      select: ENTRY_SELECT,
    }),
    doc.wikiName === null ? [] : sameNameRows(viewer, doc.id, parentId),
  ]);

  const forks = forkRows.slice(0, FAMILY_LIST_LIMIT);
  const same = sameRows.slice(0, FAMILY_LIST_LIMIT);
  if (parentId === null && forks.length === 0 && same.length === 0) return null;

  const historyWhere = reader && docsWithVisibleHistoryWhere(reader.id, reader.role);
  const listed = [doc.id, ...(parentRow ? [parentRow.id] : []), ...forks.map((fork) => fork.id)];
  const seesHistory = new Set(
    !historyWhere
      ? []
      : (await prisma.doc.findMany({ where: { AND: [{ id: { in: listed } }, historyWhere] }, select: { id: true } })).map((row) => row.id),
  );
  const firsts = await firstUpdates([
    ...(parentId !== null && seesHistory.has(doc.id) ? [doc.id] : []),
    ...forks.filter((fork) => seesHistory.has(fork.id)).map((fork) => fork.id),
  ]);

  // Named for what each compares, read after the line's "diff:", the same
  // from either doc's page: the two docs now, the parent since the fork, and
  // the fork since it began. Same name's one diff is read after nothing.
  const differ = (left: string, right: string, label: string): FamilyLink[] =>
    reader ? [{ label, href: diffPath({ docId: left, updateId: null }, { docId: right, updateId: null }) }] : [];
  const parentChanged = (parent: string, fork: string, at: bigint | null): FamilyLink[] =>
    at !== null && (seesHistory.has(parent) || seesHistory.has(fork))
      ? [{ label: "parent", href: diffPath({ docId: parent, updateId: at }, { docId: parent, updateId: null }) }]
      : [];
  const forkChanged = (fork: string): FamilyLink[] => {
    const first = firsts.get(fork);
    return first === undefined ? [] : [{ label: "fork", href: diffPath({ docId: fork, updateId: first }, { docId: fork, updateId: null }) }];
  };
  const entry = (row: (typeof forkRows)[number], diffs: FamilyLink[]): FamilyEntry => ({
    id: row.id,
    title: docTitleOrFallback(row.title),
    path: docPagePath(row),
    diffs,
  });

  let parent: DocFamily["parent"] = null;
  if (parentId !== null) {
    parent = parentRow
      ? {
          entry: entry(parentRow, [
            ...differ(parentRow.id, doc.id, "parent vs. fork"),
            ...parentChanged(parentRow.id, doc.id, doc.forkedFromUpdateId),
            ...forkChanged(doc.id),
          ]),
        }
      : { hidden: true, diffs: forkChanged(doc.id) };
  }

  return {
    parent,
    forkedAt: parentId === null ? null : doc.createdAt,
    forks: forks.map((fork) =>
      entry(fork, [
        ...differ(doc.id, fork.id, "parent vs. fork"),
        ...parentChanged(doc.id, fork.id, fork.forkedFromUpdateId),
        ...forkChanged(fork.id),
      ]),
    ),
    moreForks: forkRows.length > FAMILY_LIST_LIMIT,
    sameName: same.map((row) => entry(row, differ(doc.id, row.id, "how they differ"))),
    moreSameName: sameRows.length > FAMILY_LIST_LIMIT,
  };
}

/**
 * Up to one more than FAMILY_LIST_LIMIT other wiki pages with this page's
 * name by its key, through the wiki read rule's `where`: neither this page,
 * nor its parent, nor its forks, which have lines of their own. The commons'
 * first, then the oldest. The key is read off the row, since only the
 * database folds a name (docs/WIKI.md "Case").
 */
async function sameNameRows(viewer: { id: string; role: Role } | null, docId: string, parentId: string | null) {
  const row = await prisma.doc.findUnique({ where: { id: docId }, select: { wikiNameKey: true } });
  if (!row?.wikiNameKey) return [];
  return prisma.doc.findMany({
    where: {
      AND: [
        {
          wikiNameKey: row.wikiNameKey,
          deletedByUserId: null,
          id: { notIn: parentId === null ? [docId] : [docId, parentId] },
          // Spelled with OR because `not` alone drops a null.
          OR: [{ forkedFromDocId: null }, { forkedFromDocId: { not: docId } }],
        },
        readableWikiDocsWhere(viewer),
      ],
    },
    orderBy: [{ wikiOwnerUserId: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }, { id: "asc" }],
    take: FAMILY_LIST_LIMIT + 1,
    select: ENTRY_SELECT,
  });
}
