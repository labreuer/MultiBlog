import { prismaIncludingDeleted } from "../../prisma";
import { citedNames, cslOf, yearOf } from "../../references/csl";
import { referenceEntry } from "../../references/entry";
import type { CitationContext } from "./citation";

// docs/CITATIONS.md, "Context" — each cited reference's label parts, deleted
// ones included, with its file's page labels for a link to the page cited.
// Server-only: the browser gets the same shape from the chip-context
// endpoint.

/**
 * The citation context for these reference ids. An id with no row is left
 * out, and renders as an unknown work.
 *
 * **A file is offered only when it is SHARED.** A rendering never depends on
 * who is looking (docs/ENTITY_CHIPS.md, rule 2), so a link to a PRIVATE file
 * would be shown to every reader of the doc, naming a file most of them
 * can't open. Such a citation links to the reference's own page instead.
 */
export async function loadCitationContext(refIds: readonly string[]): Promise<CitationContext> {
  if (refIds.length === 0) return {};
  const rows = await prismaIncludingDeleted.reference.findMany({
    where: { id: { in: [...refIds] } },
    select: {
      id: true,
      key: true,
      short: true,
      csl: true,
      deletedAt: true,
      file: { select: { slug: true, visibility: true, deletedByUserId: true, pageLabels: true } },
    },
  });
  const context: CitationContext = {};
  for (const row of rows) {
    const item = cslOf(row.csl);
    const labels = row.file?.pageLabels;
    context[row.id] = {
      id: row.id,
      key: row.key,
      short: row.short,
      names: item ? citedNames(item) : "",
      year: item ? yearOf(item) : null,
      title: item?.title ?? row.key,
      deleted: row.deletedAt !== null,
      entry: item ? referenceEntry(item) : { authors: "", year: "n.d.", title: row.key, titleIsContainer: true, source: "" },
      file:
        row.file && row.file.visibility === "SHARED" && row.file.deletedByUserId === null
          ? { slug: row.file.slug, pageLabels: Array.isArray(labels) && labels.every((l) => typeof l === "string") ? (labels as string[]) : null }
          : null,
    };
  }
  return context;
}
