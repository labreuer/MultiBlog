// docs/FULLTEXT.md — searching docs: the live text, at most one store
// debounce behind (§1), under canUserReadDoc's rule (§2). There is no ADMIN
// or EDITOR bypass for a PRIVATE doc here any more than on /doc/[slug].
//
// Positioning off Doc.proseJson is what CLAUDE.md forbids; a hit positions
// nothing. It names a doc, and its link opens the live one.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readableDocsWhere } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { parseHeadline } from "./headline";
import { orderNewest, orderRanked, rankRows, snippetsFor } from "./sql";
import { remember, type KindContext, type KindSearch } from "./context";
import type { DocHit } from "./types";

/**
 * §4 step 1: the readable docs under the filters, with the date each sorts
 * by. A doc's dates are its own columns (§6): `updatedAt` moves on every
 * collab cache write, and is the date the reading view's byline shows.
 */
function candidates(ctx: KindContext): Promise<Map<string, Date>> {
  return remember(ctx, "docs", async () => {
    if (ctx.scope === "public" || !ctx.actor) return new Map();
    const readable = readableDocsWhere(ctx.actor.userId, ctx.actor.role);
    if (!readable) return new Map();
    const rows = await prisma.doc.findMany({
      where: {
        AND: [
          readable,
          ctx.authorIds.length > 0 ? { authors: { some: { userId: { in: ctx.authorIds } } } } : {},
          ctx.created ? { createdAt: ctx.created } : {},
          ctx.updated ? { updatedAt: ctx.updated } : {},
        ],
      },
      select: { id: true, updatedAt: true },
    });
    return new Map(rows.map((doc) => [doc.id, doc.updatedAt]));
  });
}

export const docsSearch: KindSearch<DocHit> = {
  async match(ctx, query) {
    const updatedAt = await candidates(ctx);
    const dateOf = (id: string) => updatedAt.get(id) ?? null;
    const ids = [...updatedAt.keys()];
    return query ? orderRanked(await rankRows("doc", ids, query), dateOf) : orderNewest(ids, dateOf);
  },

  async hits(_ctx, ids, query) {
    if (ids.length === 0) return [];
    const [snippets, rows] = await Promise.all([
      snippetsFor("doc", ids, query, { body: Prisma.sql`public.prose_text(t.prose_json)`, title: Prisma.sql`t.title` }),
      prisma.doc.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          slug: true,
          title: true,
          updatedAt: true,
          authors: {
            orderBy: { bylineOrder: "asc" },
            select: { userId: true, user: { select: { slug: true, name: true } } },
          },
        },
      }),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id): DocHit[] => {
      const doc = byId.get(id);
      if (!doc) return [];
      const snippet = snippets.get(id);
      return [
        {
          id,
          href: `/doc/${doc.slug}`,
          // An empty title is "Untitled" at render, everywhere (doc-title.ts),
          // and has nothing in it to highlight.
          title: doc.title.trim() && snippet ? snippet.title : parseHeadline(docTitleOrFallback(doc.title)),
          byline: doc.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name })),
          updatedAt: doc.updatedAt,
          snippet: snippet?.body ?? [],
        },
      ];
    });
  },
};
