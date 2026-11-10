import { prismaIncludingDeleted } from "../../prisma";
import { citedNames, cslOf, yearOf } from "../../references/csl";
import type { ReferenceRow } from "../../reference-data";
import { entryText, referenceEntry } from "../../references/entry";
import type { CitationContext, CiteCandidate } from "./citation";

// docs/CITATIONS.md, "Context" — each cited reference's label parts, deleted
// ones included. Server-only: the browser gets the same shape from the
// chip-context endpoint. Nothing about the work's PDF: a citation links to a
// route that decides, per reader, when the link is followed (citation.ts,
// `citedPagePath`).

/**
 * The citation context for these reference ids. An id with no row is left
 * out, and renders as an unknown work.
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
    },
  });
  const context: CitationContext = {};
  for (const row of rows) {
    const item = cslOf(row.csl);
    context[row.id] = {
      id: row.id,
      key: row.key,
      short: row.short,
      names: item ? citedNames(item) : "",
      year: item ? yearOf(item) : null,
      title: item?.title ?? row.key,
      deleted: row.deletedAt !== null,
      entry: item ? referenceEntry(item) : { authors: "", year: "n.d.", title: row.key, titleIsContainer: true, source: "" },
    };
  }
  return context;
}

/** Found references as a citation menu's rows, in the order given. */
export async function citeCandidatesOf(found: readonly ReferenceRow[]): Promise<CiteCandidate[]> {
  const context = await loadCitationContext(found.map((reference) => reference.id));
  return found.flatMap((reference) => (context[reference.id] ? [{ work: context[reference.id], entry: entryText(reference.item) }] : []));
}
