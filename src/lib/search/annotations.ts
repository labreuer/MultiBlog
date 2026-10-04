// docs/FULLTEXT.md — searching annotations: the last settled body and the
// quoted passage (§1), posted and on a doc or PDF this viewer may read (§2).
// An edit in progress isn't searchable, just as it isn't readable: the body
// column holds the last settled text while a session is open.
//
// A mark-anchored annotation (the doc editor's) keeps its passage in the
// doc's body rather than in `quoted_text`, so that passage isn't in its
// vector: its words find the doc instead. The hit still shows the passage,
// derived from the mark as /annotations derives it.

import type { JSONContent } from "@tiptap/core";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { visibleAnnotationEditDates } from "@/lib/annotation-data";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { docTitleOrFallback } from "@/lib/doc-title";
import { extractMarkedText } from "@/lib/tiptap-schema";
import { isWithin } from "./dates";
import { headlineTexts, orderNewest, orderRanked, rankRows, snippetsFor, windowOf } from "./sql";
import { NO_HITS, type KindContext, type KindResult } from "./context";
import type { AnnotationHit } from "./types";

export async function searchAnnotations(ctx: KindContext): Promise<KindResult<AnnotationHit>> {
  if (ctx.scope === "public" || !ctx.actor) return NO_HITS;
  const readable = readableAnnotationsWhere(ctx.actor.userId, ctx.actor.role);
  if (!readable) return NO_HITS;

  // Created is `postedAt`, when readers could first see it; `createdAt` is
  // when the composer opened, and nothing measures from it (§6).
  const candidates = await prisma.annotation.findMany({
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
  const postedAt = new Map(candidates.map((a) => [a.id, a.postedAt]));

  const ranks = ctx.query ? await rankRows("annotation", [...postedAt.keys()], ctx.query) : null;
  const matched = ranks ? [...ranks.keys()] : [...postedAt.keys()];

  // **Updated is the last edit readers are told about, never `editedAt`**,
  // which is stamped on silent edits too: a range over it would find a silent
  // edit by narrowing the dates, the thing edit-grace.ts withholds (§6). The
  // answer comes from the cards' own rule, over the matches — a small set —
  // which is why this section is filtered and ordered here rather than in SQL.
  const edits = await visibleAnnotationEditDates(matched);
  const updatedAt = new Map<string, Date>();
  for (const id of matched) {
    const updated = edits.get(id) ?? postedAt.get(id) ?? null;
    if (updated && isWithin(updated, ctx.updated)) updatedAt.set(id, updated);
  }
  const dateOf = (id: string) => updatedAt.get(id) ?? null;
  const ordered = ranks
    ? orderRanked(new Map([...ranks].filter(([id]) => updatedAt.has(id))), dateOf)
    : orderNewest([...updatedAt.keys()], dateOf);
  const onScreen = windowOf(ordered, ctx.window);

  const [snippets, rows] = await Promise.all([
    snippetsFor("annotation", onScreen, ctx.query, { body: Prisma.sql`t.body_text`, title: null }),
    prisma.annotation.findMany({
      where: { id: { in: onScreen } },
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
  // every PDF annotation), the mark's text in its doc for a mark anchor. Only
  // the docs that hold a mark anchor on screen are read, once each.
  const isMarkAnchored = (row: (typeof rows)[number]) => row.doc !== null && row.anchorFrom === null && row.quotedText === "";
  const markDocIds = [...new Set(rows.filter(isMarkAnchored).map((row) => row.doc!.id))];
  const markDocs =
    markDocIds.length > 0
      ? await prisma.doc.findMany({ where: { id: { in: markDocIds } }, select: { id: true, proseJson: true } })
      : [];
  const proseJsonByDoc = new Map(markDocs.map((doc) => [doc.id, doc.proseJson as JSONContent | null]));
  const passages = onScreen.map((id) => {
    const row = byId.get(id);
    if (!row) return "";
    if (!isMarkAnchored(row)) return row.quotedText;
    const proseJson = proseJsonByDoc.get(row.doc!.id);
    return proseJson ? extractMarkedText(proseJson, "annotation", "id", id) : "";
  });
  const quotes = await headlineTexts(passages, ctx.query);

  const hits = onScreen.flatMap((id, index): AnnotationHit[] => {
    const row = byId.get(id);
    if (!row || !row.postedAt) return [];
    const container = row.doc
      ? { kind: "doc" as const, slug: row.doc.slug, title: docTitleOrFallback(row.doc.title), path: "/doc" }
      : row.file
        ? { kind: "pdf" as const, slug: row.file.slug, title: row.file.title, path: "/pdf" }
        : null;
    if (!container) return [];
    // The name its card shows, which is also what the card's permalink id is
    // built from — so the link lands on the card.
    const writer = row.user.name ?? row.user.email;
    return [
      {
        id,
        href: `${container.path}/${container.slug}#${annotationAnchorName(writer, row.createdAt)}`,
        container: { kind: container.kind, title: container.title },
        writer,
        postedAt: row.postedAt,
        editedAt: edits.get(id) ?? null,
        snippet: snippets.get(id)?.body ?? [],
        quote: quotes[index] ?? [],
      },
    ];
  });
  return { total: ordered.length, hits };
}
