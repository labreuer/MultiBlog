// docs/FULLTEXT.md — searching PDFs: a file's title and filename, and its
// pages' text, under canUserReadFile's rule (§2). Pages are ranked inside
// the readable files and grouped under them, best page first (§4).
//
// **The latest version's pages alone** (docs/PDF.md §13, "Versions"): page
// text is keyed by version, and a hit from an earlier version's text would
// come from words `/pdf/<slug>` doesn't show. Both queries below reach
// `file_page_text` through `file.current_version_id`.

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { readableFilesWhere } from "@/lib/file-authz";
import { currentTextVersion } from "@/lib/pdf-extract";
import { pageNameForSheet, usablePageLabels } from "@/lib/pdf-page-labels";
import { formatPageName } from "@/lib/pdf-open-params";
import { latestVersionOf } from "@/lib/file-version";
import { parseHeadline, type HeadlineFragment } from "./headline";
import { bodyHeadlineSql, cleanedText, orderNewest, rankRows, snippetsFor, type TsQuery } from "./sql";
import { remember, taggedWhere, type KindContext, type KindSearch } from "./context";
import type { PdfHit } from "./types";

/** How many matching pages a file's hit shows (§10, item 6). */
export const PDF_PAGES_SHOWN = 3;

export type PageMatch = { fileId: string; fileVersionId: string; pageIndex: number; textVersion: string; rank: number };

/**
 * Every matching page of the given files' latest versions, one row per page,
 * grouped by file and best first.
 *
 * A page can have rows at several text versions — `storedPageText`
 * re-extracts on demand and keeps the old rows (docs/PDF.md §3) — so each
 * page is matched at one version only: the one this server extracts when the
 * page has it, otherwise its latest other. The correlated lookup rides the
 * primary key, and the outer match still uses the GIN index.
 */
export async function matchPages(fileIds: string[], query: TsQuery): Promise<Map<string, PageMatch[]>> {
  const byFile = new Map<string, PageMatch[]>();
  if (fileIds.length === 0) return byFile;
  const current = await currentTextVersion();
  const rows = await prisma.$queryRaw<PageMatch[]>(Prisma.sql`
    SELECT f.id AS "fileId", t.file_version_id AS "fileVersionId", t.page_index AS "pageIndex",
           t.text_version AS "textVersion", ts_rank_cd(t.search_vector, q.query, 32)::float8 AS rank
    FROM file f
    JOIN file_page_text t ON t.file_version_id = f.current_version_id
    CROSS JOIN (SELECT ${query} AS query) AS q
    WHERE f.id = ANY(${fileIds}) AND t.search_vector @@ q.query
      AND t.text_version = (
        SELECT v.text_version FROM file_page_text v
        WHERE v.file_version_id = t.file_version_id AND v.page_index = t.page_index
        ORDER BY (v.text_version = ${current}) DESC, v.text_version DESC
        LIMIT 1
      )`);
  for (const page of rows) {
    const list = byFile.get(page.fileId) ?? [];
    list.push(page);
    byFile.set(page.fileId, list);
  }
  for (const list of byFile.values()) list.sort((a, b) => b.rank - a.rank || a.pageIndex - b.pageIndex);
  return byFile;
}

/**
 * Every matching page of one version of a file, best first: `within` a PDF at
 * a version's own address (docs/PDF.md §13, "Addresses"). The site's search
 * never asks this; it ranks the latest version's pages alone (`matchPages`).
 */
export async function matchVersionPages(fileId: string, fileVersionId: string, query: TsQuery): Promise<PageMatch[]> {
  const current = await currentTextVersion();
  const rows = await prisma.$queryRaw<PageMatch[]>(Prisma.sql`
    SELECT v.file_id AS "fileId", t.file_version_id AS "fileVersionId", t.page_index AS "pageIndex",
           t.text_version AS "textVersion", ts_rank_cd(t.search_vector, q.query, 32)::float8 AS rank
    FROM file_version v
    JOIN file_page_text t ON t.file_version_id = v.id
    CROSS JOIN (SELECT ${query} AS query) AS q
    WHERE v.id = ${fileVersionId} AND v.file_id = ${fileId} AND t.search_vector @@ q.query
      AND t.text_version = (
        SELECT o.text_version FROM file_page_text o
        WHERE o.file_version_id = t.file_version_id AND o.page_index = t.page_index
        ORDER BY (o.text_version = ${current}) DESC, o.text_version DESC
        LIMIT 1
      )`);
  return rows.sort((a, b) => b.rank - a.rank || a.pageIndex - b.pageIndex);
}

export async function pageSnippets(pages: PageMatch[], query: TsQuery): Promise<Map<string, HeadlineFragment[]>> {
  if (pages.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ fileId: string; pageIndex: number; snippet: string }[]>(Prisma.sql`
    SELECT k.file_id AS "fileId", t.page_index AS "pageIndex",
           ${bodyHeadlineSql(Prisma.sql`b.body`, Prisma.sql`q.query`)} AS snippet
    FROM file_page_text t
    JOIN unnest(${pages.map((p) => p.fileId)}::text[], ${pages.map((p) => p.fileVersionId)}::text[],
                ${pages.map((p) => p.pageIndex)}::int[], ${pages.map((p) => p.textVersion)}::text[])
           AS k(file_id, file_version_id, page_index, text_version)
      ON t.file_version_id = k.file_version_id AND t.page_index = k.page_index AND t.text_version = k.text_version
    CROSS JOIN (SELECT ${query} AS query) AS q
    CROSS JOIN LATERAL (SELECT ${cleanedText(Prisma.sql`t.text`)} AS body) AS b`);
  return new Map(rows.map((row) => [`${row.fileId}:${row.pageIndex}`, parseHeadline(row.snippet)]));
}

/**
 * The readable ids, the first half of `match` (§4). A file's dates are its
 * row's (§6): the upload, and changes to its title, visibility or owners.
 * Page text never changes.
 *
 * A PDF has owners, not authors — nobody listed wrote it — and its page
 * shows no owner, so an author filter leaves PDFs out rather than reveal
 * who owns which (§10, item 8).
 */
function candidates(ctx: KindContext): Promise<Map<string, Date>> {
  return remember(ctx, "pdfs", async () => {
    if (ctx.scope === "public" || !ctx.actor || ctx.authorIds.length > 0) return new Map();
    const readable = readableFilesWhere(ctx.actor.userId, ctx.actor.role);
    if (!readable) return new Map();
    const rows = await prisma.storedFile.findMany({
      where: {
        AND: [
          readable,
          ctx.created ? { createdAt: ctx.created } : {},
          ctx.updated ? { updatedAt: ctx.updated } : {},
          taggedWhere(ctx.tagIds),
        ],
      },
      select: { id: true, updatedAt: true },
    });
    return new Map(rows.map((file) => [file.id, file.updatedAt]));
  });
}

/**
 * A page's label as the viewer shows it, or null where it has none worth
 * showing (docs/MCP.md §8) — from the stored labels only: search never parses
 * a PDF, and a version whose labels haven't been read yet shows its numbers.
 * Display only, so PDF.md's "a label never enters a computation" holds.
 */
function labelOf(file: { pageCount: number | null; pageLabels: unknown }, pageIndex: number): string | null {
  const labels = usablePageLabels(file.pageLabels as string[] | null, file.pageCount ?? 0);
  return labels ? labels[pageIndex] : null;
}

/**
 * A page hit's link: `#p=<label>` where the sheet is the first carrying its
 * own label, and `#sheet=<n>` otherwise, as for a sheet whose own label is
 * empty or a file without usable labels (docs/PDF_FRAGMENT_LINKS.md §8). It
 * is a page link nobody chooses the form of, and is copied into bodies from
 * the address bar, so it takes the form that survives a new copy of the file.
 * From the stored labels only, as `labelOf` is.
 */
function pageHref(file: { slug: string; pageCount: number | null; pageLabels: unknown }, pageIndex: number): string {
  const own = Array.isArray(file.pageLabels) ? (file.pageLabels as string[]) : null;
  return `/pdf/${file.slug}#${formatPageName(pageNameForSheet(own, file.pageCount ?? 0, pageIndex))}`;
}

export const pdfsSearch: KindSearch<PdfHit> = {
  async match(ctx, query) {
    const updatedAt = await candidates(ctx);
    const ids = [...updatedAt.keys()];
    const dateOf = (id: string) => updatedAt.get(id) ?? null;
    if (!query) return orderNewest(ids, dateOf);
    // A file is a hit through its title or filename, its pages, or both, and
    // ranks by the best of them. Listed even when no page matches (§4).
    const [titleRanks, pages] = await Promise.all([rankRows("file", ids, query), matchPages(ids, query)]);
    const score = new Map(titleRanks);
    for (const [fileId, list] of pages) score.set(fileId, Math.max(score.get(fileId) ?? 0, list[0].rank));
    return [...score.keys()].sort(
      (a, b) =>
        score.get(b)! - score.get(a)! ||
        (dateOf(b)?.getTime() ?? 0) - (dateOf(a)?.getTime() ?? 0) ||
        a.localeCompare(b),
    );
  },

  async hits(_ctx, ids, query) {
    if (ids.length === 0) return [];
    // The pages again, for the files on screen only: cheaper than carrying
    // every file's from `match`, and the same rows by construction.
    const pages = query ? await matchPages(ids, query) : new Map<string, PageMatch[]>();
    const shown = ids.flatMap((id) => (pages.get(id) ?? []).slice(0, PDF_PAGES_SHOWN));
    const [titles, snippets, rows] = await Promise.all([
      // The title only; a file's "body" is its pages, snippeted per page below.
      snippetsFor("file", ids, query, { body: Prisma.sql`''`, title: Prisma.sql`t.title` }),
      query ? pageSnippets(shown, query) : new Map<string, HeadlineFragment[]>(),
      prisma.storedFile.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, updatedAt: true, currentVersion: { select: { pageCount: true, pageLabels: true } } },
      }),
    ]);
    const byId = new Map(rows.map(({ currentVersion, ...row }) => [row.id, { ...row, ...latestVersionOf({ id: row.id, currentVersion }) }]));
    return ids.flatMap((id): PdfHit[] => {
      const file = byId.get(id);
      if (!file) return [];
      const matched = pages.get(id) ?? [];
      return [
        {
          id,
          href: `/pdf/${file.slug}`,
          title: titles.get(id)?.title ?? [],
          updatedAt: file.updatedAt,
          pages: matched.slice(0, PDF_PAGES_SHOWN).map((page) => ({
            page: page.pageIndex + 1,
            label: labelOf(file, page.pageIndex),
            href: pageHref(file, page.pageIndex),
            snippet: snippets.get(`${id}:${page.pageIndex}`) ?? [],
          })),
          morePages: Math.max(0, matched.length - PDF_PAGES_SHOWN),
        },
      ];
    });
  },
};
