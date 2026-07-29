import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { parseDocLinkMark, type DocLinkMark } from "@/lib/doc-link-anchor";

// PLAN.md §14 — neither DocLink nor DocLinkGroup joins the $extends
// soft-delete filter in src/lib/prisma.ts (that covers only post/user/doc;
// annotation is excluded on the same grounds, §14b), so every read here
// filters `deletedAt: null` by hand rather than relying on it.

export type DocLinkRow = {
  id: string;
  docId: string;
  mark: DocLinkMark | null;
  text: string | null;
  docLinkGroupId: string;
  overrideColor: string | null;
  userId: string;
  createdAt: Date;
};

export type DocLinkGroupRow = {
  id: string;
  name: string | null;
  text: string | null;
  overrideColor: string | null;
  userId: string;
};

export type DocLinkGroupWithLinks = DocLinkGroupRow & { links: DocLinkRow[] };

type RawGroupWithLinks = Prisma.DocLinkGroupGetPayload<{
  include: { links: { where: { deletedAt: null } } };
}>;

function toDocLinkRow(link: RawGroupWithLinks["links"][number]): DocLinkRow {
  return {
    id: link.id,
    docId: link.docId,
    mark: parseDocLinkMark(link.mark),
    text: link.text,
    docLinkGroupId: link.docLinkGroupId,
    overrideColor: link.overrideColor,
    userId: link.userId,
    createdAt: link.createdAt,
  };
}

// PLAN.md §14h — links whose docId is either of the pair, joined to their
// groups. This single findMany produces both the group bar dropdown's
// membership and its ←/→/↔ prefixes (derived in the caller from which of
// the two docIds each group's links touch) — one query rather than one per
// concern, so the two can't disagree.
export async function getDocLinkGroupsForPair(leftDocId: string, rightDocId: string): Promise<DocLinkGroupWithLinks[]> {
  const groups = await prisma.docLinkGroup.findMany({
    where: {
      deletedAt: null,
      links: { some: { docId: { in: [leftDocId, rightDocId] }, deletedAt: null } },
    },
    include: {
      links: { where: { docId: { in: [leftDocId, rightDocId] }, deletedAt: null } },
    },
    orderBy: { createdAt: "asc" },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    text: g.text,
    overrideColor: g.overrideColor,
    userId: g.userId,
    links: g.links.map(toDocLinkRow),
  }));
}

// PLAN.md §14h's count line's "+Y" — links belonging to those same groups
// but pointing at any *other* doc, bucketed down to a bare count. `(+Y)`
// deliberately never names those docs: the viewer may not be able to read
// them, and an integer leaks nothing a link count doesn't.
export async function countOtherDocLinks(groupIds: string[], leftDocId: string, rightDocId: string): Promise<number> {
  if (groupIds.length === 0) return 0;
  return prisma.docLink.count({
    where: {
      docLinkGroupId: { in: groupIds },
      docId: { notIn: [leftDocId, rightDocId] },
      deletedAt: null,
    },
  });
}
