// docs/FULLTEXT.md — searching docs: the live text, at most one store
// debounce behind (§1), under canUserReadDoc's rule (§2). There is no ADMIN
// or EDITOR bypass for a PRIVATE doc here any more than on /doc/[slug].
//
// Positioning off Doc.proseJson is what CLAUDE.md forbids; a hit positions
// nothing. It names a doc, and its link opens the live one.
//
// Docs and wiki pages are one table under one read rule, split on `wikiName`
// into two kinds (docs/WIKI.md, "Listing wiki pages"): this file is the docs
// kind and the halves both kinds share; wiki.ts is the wiki kind.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readableDocsWhere } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { DOC_PATH_SELECT, docPagePath } from "@/lib/wiki-address";
import { parseHeadline } from "./headline";
import { orderNewest, orderRanked, rankRows, snippetsFor, type TsQuery } from "./sql";
import { citedWhere, mentionedWhere, remember, taggedWhere, type KindContext, type KindSearch } from "./context";
import type { DocHit } from "./types";

/** Which side of the split on `wikiName`: docs that are no wiki page, or wiki pages. */
export type DocSplit = "docs" | "wiki";

/**
 * The readable ids, the first half of `match` (§4): the readable docs on one
 * side of the split under the filters, with the date each sorts by. A doc's
 * dates are its own columns (§6): `updatedAt` moves on every collab cache
 * write, and is the date the reading view's byline shows.
 */
function candidates(ctx: KindContext, split: DocSplit): Promise<Map<string, Date>> {
  return remember(ctx, split, async () => {
    if (ctx.scope === "public" || !ctx.actor) return new Map();
    const readable = readableDocsWhere(ctx.actor.userId, ctx.actor.role);
    if (!readable) return new Map();
    const rows = await prisma.doc.findMany({
      where: {
        AND: [
          readable,
          split === "docs" ? { wikiName: null } : { wikiName: { not: null } },
          ctx.authorIds.length > 0 ? { authors: { some: { userId: { in: ctx.authorIds } } } } : {},
          ctx.created ? { createdAt: ctx.created } : {},
          ctx.updated ? { updatedAt: ctx.updated } : {},
          taggedWhere(ctx.tagIds),
          mentionedWhere(ctx.mentionIds),
          citedWhere(ctx.citedIds),
        ],
      },
      select: { id: true, updatedAt: true },
    });
    return new Map(rows.map((doc) => [doc.id, doc.updatedAt]));
  });
}

/**
 * `match` over one side of the split, or both: each side's ids through its
 * own query, then ranked together, so both at once orders exactly as one
 * unsplit query would.
 */
export async function matchDocs(ctx: KindContext, query: TsQuery | null, splits: DocSplit[]): Promise<string[]> {
  const updatedAt = new Map<string, Date>();
  for (const side of await Promise.all(splits.map((split) => candidates(ctx, split)))) {
    for (const [id, date] of side) updatedAt.set(id, date);
  }
  const dateOf = (id: string) => updatedAt.get(id) ?? null;
  const ids = [...updatedAt.keys()];
  return query ? orderRanked(await rankRows("doc", ids, query), dateOf) : orderNewest(ids, dateOf);
}

/** `hits` for either side: a wiki page's link is its address, any other doc's `/doc/<slug>`. */
export const docHits: KindSearch<DocHit>["hits"] = async (_ctx, ids, query) => {
  if (ids.length === 0) return [];
  const [snippets, rows] = await Promise.all([
    snippetsFor("doc", ids, query, { body: Prisma.sql`public.prose_text(t.prose_json)`, title: Prisma.sql`t.title` }),
    prisma.doc.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        ...DOC_PATH_SELECT,
        title: true,
        updatedAt: true,
        proseJsonLength: true,
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
        href: docPagePath(doc),
        // An empty title is "Untitled" at render, everywhere (doc-title.ts),
        // and has nothing in it to highlight.
        title: doc.title.trim() && snippet ? snippet.title : parseHeadline(docTitleOrFallback(doc.title)),
        byline: doc.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name })),
        updatedAt: doc.updatedAt,
        chars: doc.proseJsonLength,
        snippet: snippet?.body ?? [],
      },
    ];
  });
};

export const docsSearch: KindSearch<DocHit> = {
  match: (ctx, query) => matchDocs(ctx, query, ["docs"]),
  hits: docHits,
};
