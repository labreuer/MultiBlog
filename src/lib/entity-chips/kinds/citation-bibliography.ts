import type { JSONContent } from "@tiptap/core";
import { entryParts, type ReferenceEntry } from "../../references/entry";
import { referencePath } from "../../references/keys";
import type { TitleMark } from "../../references/markup";
import type { ChipOccurrence, ChipContext, ChipStyles } from "../types";
import { CITATION, citationKind, citationLabelling, formFor, type CitationData, type CitationForm } from "./citation";

// docs/CITATIONS.md, "The bibliography" — the works a doc cites, listed after
// it in its citation style. Computed from the doc's citations, its style and
// the chip context, as the labels are, and never stored in the doc: the
// reading view, the editor and side-by-side compute it wherever they show
// the doc, and a post's is written into its text at publish.
//
// Pure and browser-safe.

/** One work in a doc's bibliography. */
export type BibliographyItem = {
  refId: string;
  /** The reference's page, `/references/<key>`; null for a deleted reference, shown struck through. */
  href: string | null;
  /**
   * What the doc's citations call the work, before its entry: `[3]` in the
   * numeric form, the abbreviation in the `short` form, and null for a work
   * an author-date label already finds by its first author and year.
   */
  lead: string | null;
  entry: ReferenceEntry;
  deleted: boolean;
};

export type Bibliography = { form: CitationForm; items: BibliographyItem[] };

/** The heading a bibliography is shown under, on every surface. */
export const BIBLIOGRAPHY_HEADING = "References";

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Alphabetical by first author, a work with none by its title; then year, then title. */
function byAuthor(a: BibliographyItem, b: BibliographyItem): number {
  return (
    collator.compare(a.entry.authors || a.entry.title, b.entry.authors || b.entry.title) ||
    collator.compare(a.entry.year, b.entry.year) ||
    collator.compare(a.entry.title, b.entry.title)
  );
}

/**
 * The bibliography of a doc whose chips, in doc order, are `chips`: every
 * work its citations name, once. A `numeric` doc lists them by number, which
 * is their order of first citation; the others alphabetically. A work the
 * context doesn't hold is left out, as its citation shows "unknown work".
 */
export function citationBibliography(chips: readonly ChipOccurrence[], styles: ChipStyles, context: ChipContext): Bibliography {
  const { form } = citationKind.parseStyle(styles[CITATION]);
  const works = citationKind.parseContext(context[CITATION]);
  // The chips the labels are computed from: a citation its kind refuses has no label, and numbers nothing.
  const citations = chips.flatMap((chip) => {
    if (chip.kind !== CITATION) return [];
    const data = citationKind.validate(chip.data);
    return data ? [data] : [];
  }) satisfies CitationData[];
  const { numbers, shortLabel } = citationLabelling(citations, works);

  const items: BibliographyItem[] = [];
  for (const [refId, number] of numbers) {
    const work = works[refId];
    items.push({
      refId,
      href: work.deleted ? null : referencePath(work.key),
      lead: form === "numeric" ? `[${number}]` : formFor(work, form) === "short" ? shortLabel(work) : null,
      entry: work.entry,
      deleted: work.deleted,
    });
  }
  // `numbers` is in order of first citation, which is the numeric form's order already.
  if (form !== "numeric") items.sort(byAuthor);
  return { form, items };
}

/** The title marks a post's schema can hold, as its mark names. */
const POST_MARKS: Partial<Record<TitleMark, string>> = { italic: "italic", bold: "bold" };

/**
 * A bibliography as post-side content: a heading and a paragraph per work,
 * each title linked to the work's reference page, which is public. Appended
 * to a post's text at publish (post-content.ts), so it is frozen and
 * refreshed with the labels.
 */
export function bibliographyContent(bibliography: Bibliography): JSONContent[] {
  if (bibliography.items.length === 0) return [];
  const paragraphs = bibliography.items.map((item): JSONContent => {
    const runs: JSONContent[] = [];
    if (item.lead) runs.push({ type: "text", text: `${item.lead} `, marks: [{ type: "bold" }] });
    for (const part of entryParts(item.entry)) {
      // A title's runs, in the marks a post's schema has: italics and bold. Small capitals, a
      // superscript and a subscript are the text alone there.
      for (const run of part.title && part.runs ? part.runs : [{ text: part.text }]) {
        const marks: NonNullable<JSONContent["marks"]> = [];
        for (const mark of (run as { marks?: TitleMark[] }).marks ?? []) if (POST_MARKS[mark]) marks.push({ type: POST_MARKS[mark] });
        if (part.title && item.href) marks.push({ type: "link", attrs: { href: item.href } });
        runs.push({ type: "text", text: run.text, ...(marks.length > 0 ? { marks } : {}) });
      }
    }
    const content = item.deleted ? runs.map((run) => ({ ...run, marks: [...(run.marks ?? []), { type: "strike" }] })) : runs;
    return { type: "paragraph", content };
  });
  return [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: BIBLIOGRAPHY_HEADING }] }, ...paragraphs];
}
