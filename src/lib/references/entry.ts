import { creatorsOf, yearOf, type CslItem, type CslName } from "./csl";

// docs/CITATIONS.md, "The bibliography" — the one entry format the house
// styles share, from a record's CSL-JSON fields: authors, year, title, and
// the container or publisher. A list of references, a reference's own page
// and a doc's bibliography all show a work this way.
//
// Pure and browser-safe. The parts are returned apart, so a surface can set
// the title in italics and link the entry; `entryText` is the same entry as
// one string, for a table cell or an MCP answer.

export type ReferenceEntry = {
  /** "Radner, D. and Radner, M." — or "" for a work with no creator. */
  authors: string;
  /** "2012", or "n.d." for an undated work. */
  year: string;
  title: string;
  /** Whether the title is a whole work's (set in italics) or a part of one (in quotation marks). */
  titleIsContainer: boolean;
  /** Where it appeared: the journal or book with volume, issue and pages, or the publisher and place. "" for none. */
  source: string;
};

function initials(given: string | undefined): string {
  if (!given) return "";
  return given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(" ");
}

function entryName(name: CslName): string {
  if (!name.family) return name.literal ?? "";
  const given = initials(name.given);
  return given ? `${name.family}, ${given}` : name.family;
}

/** "A", "A and B", "A, B and C"; past seven, the first six and "et al.". */
function nameList(names: CslName[]): string {
  const shown = names.map(entryName).filter(Boolean);
  if (shown.length > 7) return `${shown.slice(0, 6).join(", ")} et al.`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** CSL types whose title is a part of something larger. */
const PART_TYPES = new Set(["article-journal", "article-magazine", "article-newspaper", "chapter", "paper-conference", "entry-encyclopedia"]);

export function referenceEntry(item: CslItem): ReferenceEntry {
  const year = yearOf(item);
  const isPart = PART_TYPES.has(item.type);
  const edited = !item.author?.length && (item.editor?.length ?? 0) > 0;
  const authors = nameList(creatorsOf(item));

  const pieces: string[] = [];
  if (isPart && item["container-title"]) {
    // A chapter names its book's editors, when the chapter itself has authors.
    const editors = item.type === "chapter" && item.author?.length && item.editor?.length ? `, ed. ${nameList(item.editor)}` : "";
    const where = [item.volume ? ` ${item.volume}` : "", item.issue ? `(${item.issue})` : ""].join("");
    pieces.push(`${item.type === "chapter" ? "In " : ""}${item["container-title"]}${editors}${where}${item.page ? `, ${item.page.includes("–") ? "pp." : "p."} ${item.page}` : ""}`);
  }
  const publisher = [item["publisher-place"], item.publisher].filter(Boolean).join(": ");
  if (publisher) pieces.push(publisher);

  return {
    authors: authors ? `${authors}${edited ? ` (ed${(item.editor?.length ?? 0) > 1 ? "s" : ""}.)` : ""}` : "",
    year: year === null ? "n.d." : String(year),
    title: item.title ?? "",
    titleIsContainer: !isPart,
    source: pieces.join(". "),
  };
}

/** One run of an entry's text. The title is its own run, for a surface to italicize (when `titleIsContainer`) and link. */
export type EntryPart = { text: string; title?: true };

/** A sentence's full stop, unless it already ends in one, inside a closing quotation mark or not. */
const stopAfter = (text: string) => (/[.?!]”?$/.test(text) ? "" : ".");

/** The entry as runs: `Radner, D. (2012). ` `The Origin of Ideas` `. Oxford: Clarendon Press.` */
export function entryParts(entry: ReferenceEntry): EntryPart[] {
  // A part's title is quoted, with its full stop inside the quotation marks.
  const title = entry.titleIsContainer ? entry.title : `“${entry.title}${stopAfter(entry.title)}”`;
  const titled: EntryPart[] = [{ text: title, title: true }, { text: stopAfter(title) }];
  const source: EntryPart = { text: entry.source ? ` ${entry.source}${stopAfter(entry.source)}` : "" };
  const parts = entry.authors ? [{ text: `${entry.authors} (${entry.year}). ` }, ...titled, source] : [...titled, { text: ` (${entry.year}).` }, source];
  return parts.filter((part) => part.text !== "");
}

/** The entry as one line: `Radner, D. (2012). The Origin of Ideas. Oxford: Clarendon Press.` */
export function entryText(item: CslItem): string {
  return entryParts(referenceEntry(item))
    .map((part) => part.text)
    .join("");
}
