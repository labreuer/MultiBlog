import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { docsWithVisibleHistoryWhere, readableDocsWhere } from "@/lib/doc-authz";
import { diffPath } from "@/lib/diff-side";
import { docTitleOrFallback } from "@/lib/doc-title";
import { ydocIdForDoc } from "@/lib/ydoc-names";

// docs/FORKS.md "A doc's family" — the doc this one was forked from and the
// docs forked from it, each as this viewer may see it, with links to
// whichever diffs against this doc they may see. DocFamily.tsx renders it
// under the byline in the doc view.

/** How many forks are listed; past it, the list says there are more and doesn't count them. */
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
};

const ENTRY_SELECT = { id: true, title: true, slug: true, forkedFromUpdateId: true } as const satisfies Prisma.DocSelect;

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
 * **Only what the viewer can read is named.** Each query goes through
 * `readableDocsWhere` and spells out `deletedByUserId: null`, since a relation
 * filter goes around the soft-delete extension. The forks list gives no
 * count of the rest. A parent the viewer can't read, a deleted one included,
 * is held back, but the doc still says it is a fork: left out, a SHARED fork
 * of a PRIVATE doc would pass its parent's text off as its forker's.
 *
 * **The diff links are the ones the diff page would show this viewer**, and
 * the rule is written twice, here and in its gate (`canUserSeeDocVersion`):
 *
 * - how the two differ now, for a reader of both;
 * - what the fork changed, the fork from its first update to now, for
 *   whoever may see the fork's history. It is read off the fork alone, so it
 *   stays when the parent is held back;
 * - what the parent changed since, the parent from the fork point to now,
 *   for whoever can read the parent and may see its history or the fork's
 *   (the fork-point exception).
 *
 * Whose history the viewer may see is asked once for every doc listed,
 * through `docsWithVisibleHistoryWhere`, not row by row.
 */
export async function loadDocFamily(
  viewer: { id: string; role: Role },
  doc: { id: string; forkedFromDocId: string | null; forkedFromUpdateId: bigint | null; createdAt: Date },
): Promise<DocFamily | null> {
  const readable = readableDocsWhere(viewer.id, viewer.role);
  if (!readable) return null;
  const parentId = doc.forkedFromDocId;
  const [parentRow, forkRows] = await Promise.all([
    parentId === null
      ? null
      : prisma.doc.findFirst({ where: { AND: [{ id: parentId, deletedByUserId: null }, readable] }, select: ENTRY_SELECT }),
    prisma.doc.findMany({
      where: { AND: [{ forkedFromDocId: doc.id, deletedByUserId: null }, readable] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: FAMILY_LIST_LIMIT + 1,
      select: ENTRY_SELECT,
    }),
  ]);

  const forks = forkRows.slice(0, FAMILY_LIST_LIMIT);
  if (parentId === null && forks.length === 0) return null;

  const historyWhere = docsWithVisibleHistoryWhere(viewer.id, viewer.role);
  const listed = [doc.id, ...(parentRow ? [parentRow.id] : []), ...forks.map((fork) => fork.id)];
  const seesHistory = new Set(
    historyWhere === null
      ? []
      : (await prisma.doc.findMany({ where: { AND: [{ id: { in: listed } }, historyWhere] }, select: { id: true } })).map((row) => row.id),
  );
  const firsts = await firstUpdates([
    ...(parentId !== null && seesHistory.has(doc.id) ? [doc.id] : []),
    ...forks.filter((fork) => seesHistory.has(fork.id)).map((fork) => fork.id),
  ]);

  // Named for what each compares, read after the line's "diff:", the same
  // from either doc's page: the two docs now, the parent since the fork, and
  // the fork since it began.
  const differ = (parent: string, fork: string): FamilyLink[] => [
    { label: "parent vs. fork", href: diffPath({ docId: parent, updateId: null }, { docId: fork, updateId: null }) },
  ];
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
    path: `/doc/${row.slug}`,
    diffs,
  });

  let parent: DocFamily["parent"] = null;
  if (parentId !== null) {
    parent = parentRow
      ? {
          entry: entry(parentRow, [
            ...differ(parentRow.id, doc.id),
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
      entry(fork, [...differ(doc.id, fork.id), ...parentChanged(doc.id, fork.id, fork.forkedFromUpdateId), ...forkChanged(fork.id)]),
    ),
    moreForks: forkRows.length > FAMILY_LIST_LIMIT,
  };
}
