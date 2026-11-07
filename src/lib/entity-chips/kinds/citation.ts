import { inlineRuns, mergeRuns, runsHaveMarks, runsText, type InlineRun } from "../../inline-markdown";
import type { ReferenceEntry } from "../../references/entry";
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
  /** The printed page or pages: "49", "49–51". */
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
  /** The work's PDF, when /files holds one: its slug, and each sheet's printed label, for a link to the page cited. */
  file: { slug: string; pageLabels: string[] | null } | null;
  /** The work as a bibliography lists it (references/entry.ts). */
  entry: ReferenceEntry;
};

export type CitationContext = Record<string, CitedWork>;

export const UNKNOWN_WORK = "unknown work";

const MAX_ID_LENGTH = 64;
const MAX_ITEMS = 20;
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

/** A locator as every label writes one: no "p.", and a range with an en dash. */
export function normalizeLocator(raw: string): string {
  return raw
    .trim()
    .replace(/^pp?\.?\s*/i, "")
    .replace(/\s*(?:-{1,2}|–|—)\s*/g, "–")
    .trim();
}

// "p. 5", "pp. 5-7", "5", "5–7", "xii": what a suffix is when it is really a page.
const LOCATOR_RE = /^(?:pp?\.?\s*)?([0-9ivxlcdm]+(?:\s*(?:-{1,2}|–|—)\s*[0-9ivxlcdm]+)?)\s*(?:,\s*(.*))?$/i;

/**
 * One item as stored. A suffix that reads as a locator becomes one (`p. 5,
 * note` with no locator is locator `5`, suffix `note`), since Markdown writes
 * both in the same place and reads them back that way.
 */
function validateItem(raw: unknown): CitationItem | null {
  if (!isRecord(raw)) return null;
  const { refId } = raw;
  if (typeof refId !== "string" || refId === "" || refId.length > MAX_ID_LENGTH) return null;
  let locator = text(raw.locator);
  let suffix = words(raw.suffix);
  if (!locator && suffix) {
    const asLocator = LOCATOR_RE.exec(suffix);
    if (asLocator) {
      locator = asLocator[1];
      suffix = words(asLocator[2]);
    }
  }
  const prefix = words(raw.prefix);
  return {
    refId,
    ...(locator ? { locator: normalizeLocator(locator) } : {}),
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
    ...(raw.suppressAuthor === true ? { suppressAuthor: true } : {}),
  };
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
 * `/pdf/<slug>#page=<sheet>` for a locator the file's page labels name, else
 * null: the first page of a range, found among the printed labels, or taken
 * as the sheet itself for a file that has none.
 */
export function pdfPageHref(file: { slug: string; pageLabels: string[] | null } | null, locator: string | undefined): string | null {
  if (!file || !locator) return null;
  const first = locator.split("–")[0].trim();
  const labels = file.pageLabels;
  const sheet = labels ? labels.indexOf(first) + 1 : /^\d+$/.test(first) ? Number(first) : 0;
  return sheet > 0 ? `/pdf/${file.slug}#page=${sheet}` : null;
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
      // One link per chip, to its first work: the passage in its PDF where the doc's readers may open files, the
      // reference's own page otherwise. A post's reader always gets the reference page, since files aren't public,
      // with the page in the fragment for that page's island to offer.
      const first = data.items[0];
      const page = `/references/${known[0].key}`;
      return {
        label,
        ...formatted,
        href: pdfPageHref(known[0].file, first.locator) ?? page,
        postHref: first.locator ? `${page}#p=${encodeURIComponent(first.locator.split("–")[0])}` : page,
        status: "live",
      };
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
