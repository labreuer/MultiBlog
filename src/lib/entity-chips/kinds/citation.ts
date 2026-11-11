import { inlineRuns, mergeRuns, runsHaveMarks, runsText, type InlineRun } from "../../inline-markdown";
import { formatPageName } from "../../pdf-open-params";
import { pageNameForLabel } from "../../pdf-page-labels";
import type { ReferenceEntry } from "../../references/entry";
import { MAX_LIST_KEYS, referenceListPath, referencePath } from "../../references/keys";
import type { ChipKind, ChipRendering } from "../types";
import { citationField, escapeCitationField, writeKey } from "./citation-markdown";

// docs/CITATIONS.md — a citation stands for one or more works at a page: a
// chip whose identity is the works, shown as `(BU p. 49)`, `(Radner 2012,
// p. 49)` or `[3, p. 49]` as the doc's style says. This is the kind's
// browser-safe part; its context loader is citation-context.ts.

export const CITATION = "citation";

export const CITATION_FORMS = ["short", "author-date", "numeric"] as const;
export type CitationForm = (typeof CITATION_FORMS)[number];

/** One work in a citation, with what was said about it. */
export type CitationItem = {
  refId: string;
  /** The printed page or pages: "49", "49–51", "49, 51", "xii". Nothing else: docs/CITATIONS.md, "The page". */
  locator?: string;
  /** Words before the work, inside the citation: "see". Inline Markdown, as `citationField` stores it. */
  prefix?: string;
  /** Words after the locator, inside the citation: "emphasis added". Inline Markdown, as the prefix is. */
  suffix?: string;
  /** Leave the author out, for a sentence that has just named them. */
  suppressAuthor?: boolean;
};

/**
 * A citation's fields. `form: "narrative"` is the author in the sentence and
 * the rest in the parentheses, "Radner (2012, p. 49)"; absent, the whole
 * citation is parenthetical.
 */
export type CitationData = { items: CitationItem[]; form?: "narrative" };

/** A doc's choice for its citations. */
export type CitationStyle = { form: CitationForm };

/** What a citation's label is computed from, per work. Built by the context loader from the reference's record. */
export type CitedWork = {
  id: string;
  key: string;
  /** The abbreviation a `short` citation shows; null for a reference without one. */
  short: string | null;
  /** "Radner", "A and B", "A et al."; "" for a work with no creator. */
  names: string;
  /** null for an undated work. */
  year: number | null;
  title: string;
  deleted: boolean;
  /** The work as a bibliography lists it (references/entry.ts). */
  entry: ReferenceEntry;
};

export type CitationContext = Record<string, CitedWork>;

/** One row of a citation menu: the work, and its bibliography entry for the row. */
export type CiteCandidate = {
  /** What a citation of this work is labelled from: the record a menu hands the editor as it inserts the chip. */
  work: CitedWork;
  /** The work's bibliography entry, for the menu's row. */
  entry: string;
};

export const UNKNOWN_WORK = "unknown work";

const MAX_ID_LENGTH = 64;
// No more works than a list's page takes, so a citation's link is always one.
const MAX_ITEMS = MAX_LIST_KEYS;
const MAX_TEXT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isForm(value: unknown): value is CitationForm {
  return typeof value === "string" && (CITATION_FORMS as readonly string[]).includes(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

/** A word before or after a work: text, in the Markdown form a chip stores. */
function words(value: unknown): string | undefined {
  const folded = text(value);
  return folded === undefined ? undefined : citationField(folded);
}

/** A locator as every label writes one: no "p.", a range with an en dash, and a comma and a space between pages. */
export function normalizeLocator(raw: string): string {
  return raw
    .trim()
    .replace(/^pp?\.?\s*/i, "")
    .replace(/\s*(?:-{1,2}|–|—)\s*/g, "–")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

// docs/CITATIONS.md, "The page" — what a page is: digits, or a Roman numeral
// as front matter numbers its pages. Only a well-formed numeral, so "mild"
// and "did" are words; "mix" and "liv" are numerals, as they are to Pandoc.
// Then a range of two, or a list of either, as Pandoc reads `pp. 33-35, 38`.
const PAGE = String.raw`(?:\d+|(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))`;
const RANGE = String.raw`${PAGE}(?:\s*(?:-{1,2}|–|—)\s*${PAGE})?`;
const PAGES = String.raw`${RANGE}(?:\s*,\s*${RANGE})*`;
const PAGE_TERM = String.raw`(?:pp?\.?\s*)?`;

/** What Markdown reads after a work's key: pages, then a comma and the words after them, or words alone. */
const LOCATOR_RE = new RegExp(String.raw`^${PAGE_TERM}(${PAGES})\s*(?:,\s*(.*))?$`, "i");
/** Pages, and words after them with no comma between: "49 n. 3". */
const LEADING_PAGES_RE = new RegExp(String.raw`^${PAGE_TERM}(${PAGES})\s+(\S.*)$`, "i");
/** Words, then pages: what the `[@` menu's query ends with, "radner 49". */
// The words as short as they can be, so the locator takes every page: "radner 49, 51".
const TRAILING_PAGES_RE = new RegExp(String.raw`^(.*?\S)\s+(${PAGE_TERM}${PAGES})$`, "i");

/** Whether `raw` is a page and nothing else: what a citation's Page holds. */
export function isPageLocator(raw: string): boolean {
  return new RegExp(String.raw`^${PAGE_TERM}${PAGES}$`, "i").test(raw.trim());
}

/** The first page `locator` names, for a link to it: "49" in "49–51" and in "49, 51". */
export function firstPage(locator: string): string {
  return locator.split(/[–,]/)[0].trim();
}

/** A query that ends with pages, split: "radner 49" is the words "radner" and the locator 49. */
export function splitTrailingPages(query: string): { words: string; locator: string | null } {
  const match = TRAILING_PAGES_RE.exec(query.trim());
  return match ? { words: match[1], locator: normalizeLocator(match[2]) } : { words: query.trim(), locator: null };
}

/**
 * One item as stored, which is always what Markdown reads it back as
 * (docs/CITATIONS.md, "The page").
 *
 *  - **A locator holds pages and nothing else.** What follows its pages goes
 *    after them, "49 n. 3" becoming page 49 and "n. 3"; a locator that opens
 *    with no page ("ch. 3", "§ 4") goes after the work whole.
 *  - **Then the page and the words after it are read as Markdown reads
 *    them**, since the writer puts both in one place: a suffix that is pages
 *    joins them ("49" and "51" are pages 49, 51), and with no locator, a
 *    suffix that opens with pages gives them up.
 */
function validateItem(raw: unknown): CitationItem | null {
  if (!isRecord(raw)) return null;
  const { refId } = raw;
  if (typeof refId !== "string" || refId === "" || refId.length > MAX_ID_LENGTH) return null;
  let locator = text(raw.locator);
  let suffix = words(raw.suffix);
  if (locator && !isPageLocator(locator)) {
    const leading = LEADING_PAGES_RE.exec(locator);
    const rest = words(leading ? leading[2] : locator);
    locator = leading ? leading[1] : undefined;
    suffix = [rest, suffix].filter(Boolean).join(", ") || undefined;
  }
  const after = [locator ? pages(normalizeLocator(locator)) : "", suffix ?? ""].filter(Boolean).join(", ");
  const read = after ? LOCATOR_RE.exec(after) : null;
  locator = read ? normalizeLocator(read[1]) : undefined;
  suffix = read ? words(read[2]) : words(after);
  const prefix = words(raw.prefix);
  return {
    refId,
    ...(locator ? { locator } : {}),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(raw.suppressAuthor === true ? { suppressAuthor: true } : {}),
  };
}

/** Where a citation of the work with this key, at this locator, links: `/references/<key>/p/<first page>`, or the reference's page. */
export function citedPagePath(key: string, locator: string | undefined): string {
  const home = referencePath(key);
  return locator ? `${home}/p/${encodeURIComponent(firstPage(locator))}` : home;
}

/**
 * Where a citation of several works links (docs/CITATIONS.md, "The link"):
 * `/references/<key>,<key>,…`, in the order the citation names them, with
 * each work's first page by its place in the fragment, `#p=12,,3`. A work
 * with no page has nothing at its place, commas at the end are left off, and
 * a citation with no page at all has no fragment.
 */
export function citedWorksPath(works: readonly { key: string; locator?: string }[]): string {
  const pages = works.map((work) => (work.locator ? encodeURIComponent(firstPage(work.locator)) : ""));
  while (pages.length > 0 && pages[pages.length - 1] === "") pages.pop();
  return `${referenceListPath(works.map((work) => work.key))}${pages.length > 0 ? `#p=${pages.join(",")}` : ""}`;
}

function pages(locator: string): string {
  return `${/[–,]/.test(locator) ? "pp." : "p."} ${locator}`;
}

/** What tells one work from another in a `short` label, before any disambiguation: its abbreviation, else author and year. */
function shortBase(work: CitedWork): string {
  return work.short?.trim() || authorDate(work, false);
}

function authorDate(work: CitedWork, suppressAuthor: boolean): string {
  const who = work.names || work.title;
  const when = work.year === null ? "n.d." : String(work.year);
  return suppressAuthor ? when : `${who} ${when}`;
}

/**
 * The form one work is shown in. A reference with no abbreviation has no
 * `short` label, and falls back to author-date, so a doc mixes `(BU p. 49)`
 * and `(Radner 2012, p. 49)` until the abbreviation is filled in.
 */
export function formFor(work: CitedWork, form: CitationForm): CitationForm {
  return form === "short" && !work.short?.trim() ? "author-date" : form;
}

// A label as it is built: runs of text, the words before and after a work
// read as the Markdown they are, everything else plain.
type Label = InlineRun[];

const plain = (value: string): Label => (value ? [{ text: value }] : []);
const markdownWords = (value: string | undefined): Label => (value ? inlineRuns(value) : []);

/** The parts with any text, `separator` between them. */
function joined(parts: readonly Label[], separator: string): Label {
  return parts.filter((part) => runsText(part) !== "").flatMap((part, index) => (index > 0 ? [...plain(separator), ...part] : part));
}

/** Every part, empty or not, `separator` between them. */
function joinedAll(parts: readonly Label[], separator: string): Label {
  return parts.flatMap((part, index) => (index > 0 ? [...plain(separator), ...part] : part));
}

const withSuffix = (label: Label, item: CitationItem): Label => (item.suffix ? [...label, ...plain(", "), ...markdownWords(item.suffix)] : label);

/** The parts of one item's text inside the delimiters, for a non-numeric form. */
function itemLabel(item: CitationItem, form: CitationForm, name: string): Label {
  // `short` has no comma before the page, as the notes it comes from never had; the other forms have one.
  const named = item.locator ? `${name}${form === "short" ? " " : ", "}${pages(item.locator)}` : name;
  return withSuffix(joined([markdownWords(item.prefix), plain(named)], " "), item);
}

/**
 * The PDF at a locator's first page, else null: `/pdf/<slug>#p=<label>`, with
 * the label as the file's own labels give it, on a file with usable labels,
 * and `#page=<sheet>`, the page taken as the sheet itself, on one without,
 * if the file has that many. It is the rule a `p=` link's sheet is found by
 * (`sheetsLabelled`, docs/PDF_FRAGMENT_LINKS.md §2), so a citation and a
 * `p=` link of the same page land on the same sheet. `pageLabels` are the
 * file's own, as stored: `[]` for a file with none once its metadata is
 * read, and null before. A file with no page count isn't a PDF.
 */
export function pdfPageHref(
  file: { slug: string; pageLabels: string[] | null; pageCount: number | null } | null,
  locator: string | undefined,
): string | null {
  if (!file || !locator || file.pageCount === null) return null;
  const page = pageNameForLabel(file.pageLabels, file.pageCount, firstPage(locator));
  return page ? `/pdf/${file.slug}#${formatPageName(page)}` : null;
}

/** What every label in a doc reads from the doc's citations as a whole: each work's number and its told-apart short label. */
export type CitationLabelling = {
  /** Each work's number by first appearance, for the numeric form. */
  numbers: Map<string, number>;
  /** A work's `short` label as the doc shows it: a shared abbreviation gains the year, then the key. */
  shortLabel(work: CitedWork): string;
};

/**
 * The doc-order facts behind the labels, from every citation in the doc in
 * order: the labels and the bibliography both read them, so the two can't
 * number a work differently.
 */
export function citationLabelling(chips: readonly CitationData[], context: CitationContext): CitationLabelling {
  const numbers = new Map<string, number>();
  // Which works each `short` label stands for here: two that share one are told apart.
  const wearers = new Map<string, Set<string>>();
  for (const data of chips) {
    for (const item of data.items) {
      const work = context[item.refId];
      if (!work) continue;
      if (!numbers.has(work.id)) numbers.set(work.id, numbers.size + 1);
      const base = shortBase(work);
      let ids = wearers.get(base);
      if (!ids) wearers.set(base, (ids = new Set()));
      ids.add(work.id);
    }
  }
  // A shared short label gains the year, then the key, as two same-named people gain a qualifier.
  const shortLabel = (work: CitedWork): string => {
    const base = shortBase(work);
    const sharing = [...(wearers.get(base) ?? [])].map((id) => context[id]).filter(Boolean);
    if (sharing.length < 2 || !work.short?.trim()) return base;
    const withYear = `${base} ${work.year ?? "n.d."}`;
    const sameYear = sharing.filter((other) => other.short?.trim() === work.short?.trim() && other.year === work.year);
    return sameYear.length > 1 ? `${withYear} ${work.key}` : withYear;
  };
  return { numbers, shortLabel };
}

export const citationKind: ChipKind<CitationData, CitationStyle, CitationContext> = {
  name: CITATION,
  // Pandoc's syntax, written below and read by citation-markdown.ts.
  readsMarkdown: true,

  validate(data) {
    if (!isRecord(data) || !Array.isArray(data.items)) return null;
    const items = data.items.slice(0, MAX_ITEMS).map(validateItem);
    if (items.length === 0 || items.some((item) => item === null)) return null;
    const valid = items as CitationItem[];
    // A narrative citation holds one work, with no prefix and its author
    // shown: Pandoc has no form for the others, so they aren't stored.
    if (data.form === "narrative" && valid.length === 1 && !valid[0].prefix && !valid[0].suppressAuthor) {
      return { items: valid, form: "narrative" };
    }
    return { items: valid };
  },

  // The works. Order is not part of it: "[@a; @b]" reordered cites the same two.
  identity: (data) => [...new Set(data.items.map((item) => item.refId))].sort().join(","),

  // A citation holding every work of an old one continues it, so adding a
  // work keeps the chip's instance id and the anchors on it.
  continues: (prev, next) => prev.items.every((was) => next.items.some((now) => now.refId === was.refId)),

  targets: (data) => [...new Set(data.items.map((item) => item.refId))],

  // An array contains another when each of the other's elements is contained by one of its own.
  naming: (refId) => ({ items: [{ refId }] }),

  parseStyle(raw) {
    const style = isRecord(raw) ? raw : {};
    return { form: isForm(style.form) ? style.form : "short" };
  },

  parseContext(raw) {
    return isRecord(raw) ? (raw as CitationContext) : {};
  },

  render(chips, style, context) {
    const { form } = style;
    const { numbers, shortLabel } = citationLabelling(chips, context);

    return chips.map((data): ChipRendering => {
      const works = data.items.map((item) => context[item.refId]);
      if (works.some((work) => !work)) return { label: UNKNOWN_WORK, href: null, postHref: null, status: "unknown" };
      const known = works as CitedWork[];
      const [open, close] = form === "numeric" ? ["[", "]"] : ["(", ")"];

      let built: Label;
      if (form === "numeric") {
        const inner = joinedAll(
          data.items.map((item, index) => {
            const n = String(numbers.get(known[index].id) ?? "?");
            return withSuffix(joined([markdownWords(item.prefix), plain(item.locator ? `${n}, ${pages(item.locator)}` : n)], " "), item);
          }),
          "; ",
        );
        // Suppressing the author changes nothing in a numeric citation, as in citeproc.
        const lead = data.form === "narrative" ? `${known[0].names || known[0].title} ` : "";
        built = [...plain(`${lead}${open}`), ...inner, ...plain(close)];
      } else if (data.form === "narrative") {
        const [item] = data.items;
        const [work] = known;
        // The work in the sentence, and the rest in the parentheses.
        const shown = formFor(work, form);
        const who = shown === "short" ? shortLabel(work) : work.names || work.title;
        const inside =
          shown === "short"
            ? item.locator
              ? pages(item.locator)
              : ""
            : [work.year === null ? "n.d." : String(work.year), item.locator ? pages(item.locator) : ""].filter(Boolean).join(", ");
        const rest = joined([plain(inside), markdownWords(item.suffix)], ", ");
        built = runsText(rest) ? [...plain(`${who} ${open}`), ...rest, ...plain(close)] : plain(who);
      } else {
        const inner = joinedAll(
          data.items.map((item, index) => {
            const work = known[index];
            const shown = formFor(work, form);
            // With the author suppressed, a short citation is its page alone, and an author-date one its year.
            const name = shown === "short" ? (item.suppressAuthor ? "" : shortLabel(work)) : authorDate(work, item.suppressAuthor === true);
            return name ? itemLabel(item, shown, name) : withSuffix(joined([markdownWords(item.prefix), plain(item.locator ? pages(item.locator) : "")], " "), item);
          }),
          "; ",
        );
        built = [...plain(open), ...inner, ...plain(close)];
      }
      // The label is the text alone, for everything that reads a chip as text; the runs, when the words carry
      // any formatting, are for what draws one.
      const runs = mergeRuns(built);
      const label = runsText(runs);
      const formatted = runsHaveMarks(runs) ? { runs } : {};

      if (known.some((work) => work.deleted)) return { label, ...formatted, href: null, postHref: null, status: "deleted" };
      // One link per chip, the same for every reader (docs/CITATIONS.md, "The link"). Each work once, in the
      // order first named, at the first page of the first item naming it that has one. One work links to its
      // page, at a page through the route that sends whoever follows it to the PDF there if they may open it;
      // several link to the page listing them all.
      const cited: { id: string; key: string; locator?: string }[] = [];
      data.items.forEach((item, index) => {
        const work = known[index];
        const seen = cited.find((entry) => entry.id === work.id);
        if (!seen) cited.push({ id: work.id, key: work.key, ...(item.locator ? { locator: item.locator } : {}) });
        else if (!seen.locator && item.locator) seen.locator = item.locator;
      });
      const href = cited.length === 1 ? citedPagePath(cited[0].key, cited[0].locator) : citedWorksPath(cited);
      return { label, ...formatted, href, postHref: href, status: "live" };
    });
  },

  // Pandoc's citation syntax, keyed by the works' keys, so every field
  // round-trips whatever style the doc shows: `[see @radner2012, p. 49;
  // @barfield1957]`, `[-@radner2012]`, and `@radner2012 [p. 49]` for the
  // narrative form. A work that is gone is written with its stored id. A
  // bare key that its neighbours would change is braced by the writer, which
  // sees them (markdown-import.ts).
  markdown(data, rendering, context) {
    const keyOf = (item: CitationItem) => writeKey(context[item.refId]?.key ?? item.refId);
    const after = (item: CitationItem) =>
      escapeCitationField([item.locator ? pages(item.locator) : "", item.suffix ?? ""].filter(Boolean).join(", "));
    let out: string;
    if (data.form === "narrative") {
      const [item] = data.items;
      out = `${keyOf(item)}${after(item) ? ` [${after(item)}]` : ""}`;
    } else {
      out = `[${data.items
        .map((item) => `${item.prefix ? `${escapeCitationField(item.prefix)} ` : ""}${item.suppressAuthor ? "-" : ""}${keyOf(item)}${after(item) ? `, ${after(item)}` : ""}`)
        .join("; ")}]`;
    }
    return rendering.status === "live" ? out : `~~${out}~~`;
  },
};
