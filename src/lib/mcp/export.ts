import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { docsSearch } from "@/lib/search/docs";
import { searchAuthorOptions } from "@/lib/search/authors";
import { dayRangeToInstants } from "@/lib/search/dates";
import { DEFAULT_TIME_ZONE, isTimeZone, parseDay } from "@/lib/search/params";
import { loadDocState } from "@/lib/doc-state";
import { docContentToMarkdown } from "@/lib/markdown-import";
import { docText } from "@/lib/doc-text";
import { docTitleOrFallback } from "@/lib/doc-title";
import { tagsForTarget } from "@/lib/tag-data";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { searchActorOf, type Actor } from "@/lib/actor";
import { ApiError, invalid } from "@/lib/api/errors";
import { tarEnd, tarEntry } from "@/lib/tar";
import { bylineOf } from "./shape";
import { parse, readableDocByParam } from "./resolve";

// docs/MCP.md §6, "Exporting" — docs as local files, for a sweep that reads
// every doc for a concept rather than searching for its words: Grep can
// narrow them before anything is read, and subagents can read them whole.
// One request where `read` would take a call per doc.
//
// **Which docs**: those search's listing filters select (tags, authors,
// dates), or a list of ids or URLs; with neither, every doc the actor can
// read. Either way through `readableDocsWhere`, as every listing of readable
// rows is — the docs searcher's own candidate step is reused rather than
// restated.
//
// **Each doc is read as `read` reads it**, from its `ydoc` row, and `version`
// is the one `read` returns, so an export and a read of one doc agree, and a
// quote taken from an exported file anchors at the version beside it.

export type ExportFormat = "markdown" | "text" | "json";

export type ExportSelection = {
  docIds: string[];
  /** URLs or ids the actor asked for that name no doc it can read. */
  missing: string[];
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function listParam(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

/** The docs a GET's filters select, strictly parsed: a malformed filter is refused, never dropped. */
export async function selectByFilters(actor: Actor, params: URLSearchParams): Promise<ExportSelection> {
  const kinds = listParam(params, "kinds");
  if (kinds.some((kind) => kind !== "docs")) throw invalid("The export holds docs only; a PDF's text is read by page.");
  const authors = listParam(params, "authors");
  const tags = listParam(params, "tags");
  for (const slug of [...authors, ...tags]) if (!SLUG_RE.test(slug)) throw invalid(`${slug} isn't a slug.`);
  const day = (name: string) => {
    const value = params.get(name);
    if (value === null) return null;
    if (parseDay(value) !== value) throw invalid(`${name} is a real day, YYYY-MM-DD.`);
    return value;
  };
  const tz = params.get("tz") ?? DEFAULT_TIME_ZONE;
  if (!isTimeZone(tz)) throw invalid("tz is an IANA time zone.");

  let authorIds: string[] = [];
  if (authors.length > 0) {
    const picker = await searchAuthorOptions(searchActorOf(actor), "viewer");
    const known = new Map(picker.map((option) => [option.slug, option.id]));
    const unknown = authors.filter((slug) => !known.has(slug));
    if (unknown.length > 0) throw new ApiError("unknown_author", "No author you can see has that slug.", { slugs: unknown });
    authorIds = authors.map((slug) => known.get(slug)!);
  }
  let tagIds: string[] = [];
  if (tags.length > 0) {
    const live = await prisma.tag.findMany({ where: { slug: { in: tags } }, select: { id: true, slug: true } });
    const unknown = tags.filter((slug) => !live.some((tag) => tag.slug === slug));
    if (unknown.length > 0) throw invalid("No tag has that slug.", { slugs: unknown });
    tagIds = live.map((tag) => tag.id);
  }

  const docIds = await docsSearch.match(
    {
      actor: searchActorOf(actor),
      scope: "viewer",
      authorIds,
      created: dayRangeToInstants({ from: day("created_from"), to: day("created_to") }, tz),
      updated: dayRangeToInstants({ from: day("updated_from"), to: day("updated_to") }, tz),
      excludePostId: null,
      tagIds,
      memo: new Map(),
    },
    null,
  );
  return { docIds, missing: [] };
}

/** The docs a POST names, each by URL or id, each through `read`'s own resolution and gate. */
export async function selectByList(actor: Actor, refs: unknown): Promise<ExportSelection> {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string") || refs.length > 5000) {
    throw invalid('POST a JSON body of the form {"docs": ["/doc/<slug>", "<id>", …]}.');
  }
  const docIds: string[] = [];
  const missing: string[] = [];
  for (const ref of refs as string[]) {
    const parsed = parse(ref);
    const param = parsed.kind === "doc" ? parsed.param : parsed.kind === "id" ? parsed.id : null;
    try {
      if (param === null) throw invalid(ref);
      const doc = await readableDocByParam(actor, param);
      if (!docIds.includes(doc.id)) docIds.push(doc.id);
    } catch {
      missing.push(ref);
    }
  }
  return { docIds, missing };
}

/**
 * The catalog: each doc's id, slug, title and size, and the newest entry in
 * its log — `max(ydoc_update.id)`, from one grouped query — which is how a
 * local copy finds what changed: a doc whose newest entry differs from the
 * version beside its copy is fetched again. Every writer of a doc's content
 * appends to its log, so the newest entry is right whoever wrote it; while
 * someone types it can run ahead of the stored bytes, which costs a refetch,
 * never a missed change.
 */
export async function exportCatalog(selection: ExportSelection) {
  const docs = await prisma.doc.findMany({
    where: { id: { in: selection.docIds } },
    select: { id: true, slug: true, title: true, proseJsonLength: true },
  });
  const ydocIds = docs.map((doc) => ydocIdForDoc(doc.id));
  const newest = ydocIds.length
    ? await prisma.$queryRaw<{ ydocId: string; version: bigint }[]>(Prisma.sql`
        SELECT ydoc_id AS "ydocId", max(id) AS version FROM ydoc_update WHERE ydoc_id = ANY(${ydocIds}) GROUP BY ydoc_id`)
    : [];
  const versions = new Map(newest.map((row) => [row.ydocId, row.version.toString()]));
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  return {
    docs: selection.docIds.flatMap((id) => {
      const doc = byId.get(id);
      if (!doc) return [];
      return [
        {
          id,
          slug: doc.slug,
          title: docTitleOrFallback(doc.title),
          chars: doc.proseJsonLength,
          version: versions.get(ydocIdForDoc(id)) ?? null,
        },
      ];
    }),
    ...(selection.missing.length > 0 ? { missing: selection.missing } : {}),
  };
}

const encoder = new TextEncoder();

/**
 * The export's tar: one `<id>.md` (or `.txt`, or `.json`) per doc — named by
 * id, which survives a change of slug — each Markdown or text file opening
 * with a front-matter block (id, slug, title, version), and a
 * `manifest.json`. Streamed one doc at a time, so a long export never holds
 * the one web process.
 */
export function exportTar(selection: ExportSelection, format: ExportFormat): ReadableStream<Uint8Array> {
  const manifest: Record<string, unknown>[] = [];
  let index = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      if (index < selection.docIds.length) {
        const id = selection.docIds[index++];
        const row = await prisma.doc.findUnique({
          where: { id },
          select: {
            slug: true,
            title: true,
            updatedAt: true,
            proseJsonLength: true,
            authors: { orderBy: { bylineOrder: "asc" }, select: { user: { select: { name: true } } } },
          },
        });
        if (!row) return;
        const [state, chips] = await Promise.all([loadDocState(id), tagsForTarget({ kind: "doc", id })]);
        const version = state.version?.toString() ?? null;
        const title = docTitleOrFallback(row.title);
        let name: string;
        let body: string;
        if (format === "json") {
          name = `${id}.json`;
          body = JSON.stringify(state.json);
        } else {
          name = `${id}.${format === "text" ? "txt" : "md"}`;
          const front = ["---", `id: ${id}`, `slug: ${row.slug}`, `title: ${JSON.stringify(title)}`, `version: ${JSON.stringify(version)}`, "---", ""];
          const content = format === "text" ? docText(state.blocks) : docContentToMarkdown(state.json).trim();
          body = `${front.join("\n")}\n${content}\n`;
        }
        manifest.push({
          id,
          slug: row.slug,
          title,
          chars: row.proseJsonLength,
          version,
          byline: bylineOf(row.authors.map((a) => a.user)),
          ...(chips.length > 0 ? { tags: chips.map((chip) => chip.slug) } : {}),
          file: name,
        });
        controller.enqueue(tarEntry(name, encoder.encode(body), row.updatedAt));
        return;
      }
      const tail = { docs: manifest, ...(selection.missing.length > 0 ? { missing: selection.missing } : {}) };
      controller.enqueue(tarEntry("manifest.json", encoder.encode(JSON.stringify(tail, null, 1))));
      controller.enqueue(tarEnd());
      controller.close();
      done = true;
    },
  });
}
