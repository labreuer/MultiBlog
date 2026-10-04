// docs/FULLTEXT.md — searching annotations: the last settled body and the
// quoted passage (§1), posted and on a doc or PDF this viewer may read (§2).
// An edit in progress isn't searchable, just as it isn't readable: the body
// column holds the last settled text while a session is open.
//
// A mark-anchored annotation (the doc editor's) keeps its passage in the
// doc's body rather than in `quoted_text`, so that passage isn't in its
// vector: its words find the doc instead (§10, item 9). The hit still shows
// the passage, derived from the mark as /annotations derives it.

import type { JSONContent } from "@tiptap/core";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { visibleAnnotationEditDates } from "@/lib/annotation-data";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { docTitleOrFallback } from "@/lib/doc-title";
import { extractMarkedText } from "@/lib/tiptap-schema";
import { isWithin } from "./dates";
import { headlineTexts, orderNewest, orderRanked, rankRows, snippetsFor } from "./sql";
import { remember, type KindContext, type KindSearch } from "./context";
import type { AnnotationHit } from "./types";

/**
 * The readable ids, the first half of `match` (§4): the readable, live
 * annotations under the filters, each with when it was posted. Created is
 * `postedAt`, when readers could first see it; `createdAt` is when the
 * composer opened, and nothing measures from it (§6).
 */
function candidates(ctx: KindContext): Promise<Map<string, Date>> {
  return remember(ctx, "annotations", async () => {
    if (ctx.scope === "public" || !ctx.actor) return new Map();
    const readable = readableAnnotationsWhere(ctx.actor.userId, ctx.actor.role);
    if (!readable) return new Map();
    const rows = await prisma.annotation.findMany({
      where: {
        AND: [
          readable,
          { deletedByUserId: null },
          ctx.authorIds.length > 0 ? { userId: { in: ctx.authorIds } } : {},
          ctx.created ? { postedAt: ctx.created } : {},
        ],
      },
      select: { id: true, postedAt: true },
    });
    // A posted annotation always has postedAt; a row without one never
    // reached readers, whatever its status says.
    return new Map(rows.flatMap((a) => (a.postedAt ? [[a.id, a.postedAt] as const] : [])));
  });
}

/**
 * **Updated is the last edit readers are told about, never `editedAt`**,
 * which is stamped on silent edits too: a range over it would find a silent
 * edit by narrowing the dates, the thing edit-grace.ts withholds (§6). The
 * answer is the cards' own rule, for every candidate at once — which is why
 * this section is filtered and ordered here rather than in SQL.
 */
function updatedDates(ctx: KindContext): Promise<{ updated: Map<string, Date>; edited: Map<string, Date | null> }> {
  return remember(ctx, "annotations:updated", async () => {
    const posted = await candidates(ctx);
    const edited = await visibleAnnotationEditDates([...posted.keys()]);
    const updated = new Map<string, Date>();
    for (const [id, postedAt] of posted) {
      const date = edited.get(id) ?? postedAt;
      if (isWithin(date, ctx.updated)) updated.set(id, date);
    }
    return { updated, edited };
  });
}

export const annotationsSearch: KindSearch<AnnotationHit> = {
  async match(ctx, query) {
    const { updated } = await updatedDates(ctx);
    const dateOf = (id: string) => updated.get(id) ?? null;
    const ids = [...updated.keys()];
    return query ? orderRanked(await rankRows("annotation", ids, query), dateOf) : orderNewest(ids, dateOf);
  },

  async hits(ctx, ids, query) {
    if (ids.length === 0) return [];
    const [{ edited }, snippets, rows] = await Promise.all([
      updatedDates(ctx),
      snippetsFor("annotation", ids, query, { body: Prisma.sql`t.body_text`, title: null }),
      prisma.annotation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          createdAt: true,
          postedAt: true,
          anchorFrom: true,
          quotedText: true,
          user: { select: { name: true, email: true } },
          doc: { select: { id: true, slug: true, title: true } },
          file: { select: { slug: true, title: true } },
        },
      }),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // The passage each quotes: the stored column for a column anchor (and for
    // every PDF annotation), the mark's text in its doc for a mark anchor.
    // Only the docs holding a mark anchor on screen are read, once each.
    const isMarkAnchored = (row: (typeof rows)[number]) =>
      row.doc !== null && row.anchorFrom === null && row.quotedText === "";
    const markDocIds = [...new Set(rows.filter(isMarkAnchored).map((row) => row.doc!.id))];
    const markDocs =
      markDocIds.length > 0
        ? await prisma.doc.findMany({ where: { id: { in: markDocIds } }, select: { id: true, proseJson: true } })
        : [];
    const proseJsonByDoc = new Map(markDocs.map((doc) => [doc.id, doc.proseJson as JSONContent | null]));
    const passages = ids.map((id) => {
      const row = byId.get(id);
      if (!row) return "";
      if (!isMarkAnchored(row)) return row.quotedText;
      const proseJson = proseJsonByDoc.get(row.doc!.id);
      return proseJson ? extractMarkedText(proseJson, "annotation", "id", id) : "";
    });
    const quotes = await headlineTexts(passages, query);

    return ids.flatMap((id, index): AnnotationHit[] => {
      const row = byId.get(id);
      if (!row || !row.postedAt) return [];
      const container = row.doc
        ? { kind: "doc" as const, slug: row.doc.slug, title: docTitleOrFallback(row.doc.title), path: "/doc" }
        : row.file
          ? { kind: "pdf" as const, slug: row.file.slug, title: row.file.title, path: "/pdf" }
          : null;
      if (!container) return [];
      // The name its card shows, which is also what the card's permalink id
      // is built from — so the link lands on the card.
      const writer = row.user.name ?? row.user.email;
      return [
        {
          id,
          href: `${container.path}/${container.slug}#${annotationAnchorName(writer, row.createdAt)}`,
          container: { kind: container.kind, title: container.title },
          writer,
          postedAt: row.postedAt,
          editedAt: edited.get(id) ?? null,
          snippet: snippets.get(id)?.body ?? [],
          quote: quotes[index] ?? [],
        },
      ];
    });
  },
};
