import type { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { canUserReadDoc } from "@/lib/doc-authz";
import { readablePostWhere } from "@/lib/post-status";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { DEFAULT_TABLE_PREFS } from "@/lib/table-query";
import { canViewReferences } from "@/lib/role-checks";
import { cslDataOf } from "@/lib/references/csl";
import { EXPORT_FORMATS, type ExportFormat, type ExportRecord } from "@/lib/references/export";
import { isKeyShaped } from "@/lib/references/keys";
import { parseReferencesFilters } from "@/lib/references-query";
import { referencesWhere } from "@/lib/references-where";
import { referenceByKey } from "@/lib/reference-data";

// docs/CITATIONS.md, "Downloads" — which works a download holds, by its one
// selection, each under its own gate, and the file it is named. Server-only:
// the route (`/api/references/export`) and the bulk export both ask here.
//
// | Selection | Works | Gate |
// |---|---|---|
// | `key=` | that one | none: a record is public |
// | `doc=` | what the doc cites | `canUserReadDoc`, else not found |
// | `post=` | what the post cites | `readablePostWhere`, else not found |
// | `ids=` | the rows selected in /references | `canViewReferences` |
// | /references' querystring | what its search matches, every page | `canViewReferences` |

/** Works in the library's order: by author and then year, deleted ones included. */
export async function referencesInLibraryOrder(where: Prisma.ReferenceWhereInput): Promise<ExportRecord[]> {
  const rows = await prismaIncludingDeleted.reference.findMany({
    where,
    orderBy: [{ listing: { people: { sort: "asc", nulls: "last" } } }, { listing: { year: { sort: "asc", nulls: "last" } } }, { listing: { title: { sort: "asc", nulls: "last" } } }, { key: "asc" }],
    select: { key: true, csl: true },
  });
  return rows.flatMap((row) => {
    const data = cslDataOf(row.csl);
    return data ? [{ key: row.key, data }] : [];
  });
}

/** The works a doc's or post's References list: the `citation` table's, deleted ones included, as the list strikes them through. */
const citedBy = (source: { docId: string } | { postId: string }): Prisma.ReferenceWhereInput => ({ citations: { some: source } });

/** A file name: a key's `:` as `_`, since Windows allows none in one, and nothing else a file name can't hold. */
export function downloadName(base: string, format: ExportFormat): string {
  return `${base.replace(/[:\\/*?"<>|\s]+/g, "_") || "references"}${EXPORT_FORMATS[format].extension}`;
}

/**
 * The works `params` selects, and the name of their file, for this viewer; or
 * null where the selection names nothing this viewer may download, the same
 * answer as for one that names nothing at all.
 */
export async function downloadSelection(viewer: Actor | null, params: URLSearchParams, format: ExportFormat): Promise<{ records: ExportRecord[]; name: string } | null> {
  const key = params.get("key");
  if (key !== null) {
    if (!isKeyShaped(key)) return null;
    const reference = await referenceByKey(key);
    if (!reference) return null;
    const records = await referencesInLibraryOrder({ id: reference.id });
    return { records, name: downloadName(reference.key, format) };
  }

  const docId = params.get("doc");
  if (docId !== null) {
    if (!viewer) return null;
    const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { id: true, slug: true, visibility: true } });
    if (!doc || !(await canUserReadDoc(viewer.userId, viewer.role, doc))) return null;
    return { records: await referencesInLibraryOrder(citedBy({ docId: doc.id })), name: downloadName(doc.slug, format) };
  }

  const postId = params.get("post");
  if (postId !== null) {
    const post = await prisma.post.findFirst({ where: { AND: [readablePostWhere(viewer?.userId ?? null, viewer?.role ?? null), { id: postId }] }, select: { id: true, slug: true } });
    if (!post) return null;
    return { records: await referencesInLibraryOrder(citedBy({ postId: post.id })), name: downloadName(post.slug, format) };
  }

  if (!viewer || !canViewReferences(viewer.role)) return null;
  const ids = params.get("ids");
  if (ids !== null) {
    const list = ids.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 1000);
    return { records: await referencesInLibraryOrder({ id: { in: list } }), name: downloadName("references", format) };
  }
  const where = await referencesWhere(parseReferencesFilters(params, DEFAULT_TABLE_PREFS));
  return { records: await referencesInLibraryOrder(where), name: downloadName("references", format) };
}
