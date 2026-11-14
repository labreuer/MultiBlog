import { parsePdfPath } from "./file-version";
import { namedVersion, type PageReading } from "./pdf-link-reading";
import { pageFromHash, type PageName, type PageStamp } from "./pdf-open-params";
import { sheetsNamed, usablePageLabels } from "./pdf-page-labels";
import {
  countPassageOccurrences,
  parseFragmentPassages,
  resolvePassage,
  skeletonOf,
  type FragmentPassage,
  type PassageText,
  type Skeleton,
} from "./pdf-fragment";

// docs/PDF_FRAGMENT_LINKS.md §8 — the pure half of the check: which hrefs are
// fragment links or page links, what a passage or a page comes to against a
// file's pages, and the findings that says it in. Pure and isomorphic, like
// src/lib/pdf-fragment.ts, so its rejection surface is a unit test;
// src/lib/pdf-fragment-check.ts reads the pages and labels it is given.

/** How a fragment link's href names its file and passages, or a page link's its page. Null when the href is neither. */
export type FragmentLinkHref = {
  slug: string;
  /** The version whose own address the href names, `/pdf/<slug>/v/<n>`; null for the bare address (docs/PDF.md §13, "Links into the file"). */
  version: number | null;
  passages: FragmentPassage[];
  /** A page link's page: an href with a `page` or a `p` and no `text`. Null for a fragment link. */
  page: PageName | null;
  /** `text` parameters the grammar couldn't read, or that named no page, or came past the limit. */
  unread: number;
};

// Resolves a relative href; never fetched.
const PROBE_ORIGIN = "https://fragment-check.invalid";

/**
 * A fragment link's slug and passages: an href to `/pdf/<slug>`, or to a
 * version's own address `/pdf/<slug>/v/<n>`, whose fragment has at least one
 * `text` parameter, written relative or absolute on `siteOrigin`. One whose fragment has a readable `page` or `p` and no
 * `text` is a page link, with its page and no passages. A link to a PDF with
 * neither is null here.
 */
export function parseFragmentLinkHref(href: string, siteOrigin: string | null): FragmentLinkHref | null {
  let url: URL;
  try {
    if (href.startsWith("/") && !href.startsWith("//")) {
      url = new URL(href, PROBE_ORIGIN);
    } else {
      if (!siteOrigin) return null;
      url = new URL(href);
      if (url.origin !== new URL(siteOrigin).origin) return null;
    }
  } catch {
    return null;
  }
  const path = parsePdfPath(url.pathname);
  if (!path) return null;
  const textParams = url.hash
    .replace(/^#/, "")
    .split("&")
    .filter((param) => param.startsWith("text=")).length;
  const page = textParams === 0 ? pageFromHash(url.hash) : null;
  if (textParams === 0 && page === null) return null;
  const { slug, version } = path;
  if (page) return { slug, version, passages: [], page, unread: 0 };
  const passages = parseFragmentPassages(url.hash);
  return { slug, version, passages, page: null, unread: textParams - passages.length };
}

/**
 * The version each page of a link names, as the viewer reads it on the
 * link's own address (`namedVersion`): its `v=`, else the version the address
 * names, else the first.
 */
export function versionNamedBy(link: Pick<FragmentLinkHref, "version">, page: PageName): number {
  return namedVersion(page, link.version === null ? { shown: 0, own: false } : { shown: link.version, own: true });
}

/**
 * A link's page that names a version with nothing to read: abandoned, or one
 * the file never had. An abandoned version's link is carried off it by its
 * page map; `mapped` says the maps were there and the sheet had no
 * counterpart, where otherwise a map on the way is missing.
 */
export type VersionFault = { kind: "abandoned-version"; /** The version named. */ version: number; mapped?: boolean } | { kind: "no-such-version"; version: number };

/**
 * How a finding on one version came from a link that names another: it was
 * carried there through the page maps, as the viewer carries it (docs/PDF.md
 * §13, "Links into the file"). `from` is the version the link names.
 */
export type Carried = { from: number };

export type PassageFinding =
  | (VersionFault & { passage: FragmentPassage })
  | {
      kind: "ok";
      passage: FragmentPassage;
      /** The version it was read on: the one it names, or the one it was carried to. */
      version: number;
      /** The 1-based sheet it was found on: the first of the sheets its page names, or was carried to, that holds it. */
      sheet: number;
      /** The page's text at the match. */
      text: string;
      /** How many places on the page this form finds; above 1, the link points at the first. */
      occurrences: number;
      /** Set where the link names another version than `version`; `byWords` where its sheet had no counterpart and its words were found once. */
      carried?: Carried & { byWords?: boolean };
    }
  | {
      kind: "no-match";
      passage: FragmentPassage;
      version: number;
      /** The 1-based sheets its page names, or was carried to, in order: one for `sheet=`, any number for a repeated label. */
      sheets: number[];
      /** The longest stretch of the passage the first of them holds, and what that page has right after it. */
      matchedUpTo: string | null;
      pageHasThere: string | null;
      /** The 1-based page the passage is on instead, when it occurs exactly once elsewhere in the file. */
      foundOnPage: number | null;
      /** Set where the link was carried to `version` and its words aren't where it landed; `namedHolds` where the version it names has them. */
      carried?: Carried & { namedHolds: boolean };
    }
  | { kind: "page-out-of-range"; passage: FragmentPassage; version: number; pageCount: number }
  | {
      kind: "no-such-label";
      passage: FragmentPassage;
      version: number;
      /** As for a miss: the page the passage is on, when it occurs exactly once in the file. */
      foundOnPage: number | null;
    };

/** What a page link's page comes to. */
export type PageLinkFinding =
  | VersionFault
  | { kind: "ok"; version: number; /** 1-based: the sheet it opens at. */ sheet: number; carried?: Carried }
  | { kind: "page-out-of-range"; version: number; pageCount: number }
  | { kind: "no-such-label"; version: number };

export type FragmentLinkFinding =
  | { kind: "unknown-file"; slug: string }
  | {
      kind: "checked";
      slug: string;
      /** The file's slug now; different from `slug` when the link names a past one. */
      currentSlug: string;
      fileId: string;
      /** How many versions the file has, every row counted; above 1, a link without `v=` names its first. */
      versionCount: number;
      /** The latest version's number. */
      latestVersion: number;
      /** The version whose own address the link names; null for the bare address. */
      addressVersion: number | null;
      passages: PassageFinding[];
      /** A page link's finding; null for a fragment link. */
      page: PageLinkFinding | null;
      /**
       * Whether the file has usable labels, for a link with a `p=`, and null
       * for one without, whose answer needs no labels. A `p=` on a file
       * without them is a sheet number, and would turn into a printed page
       * the day the file gained labels: the warning gives its `sheet=` form.
       */
      usableLabels: boolean | null;
      unread: number;
    };

/** One version of a file's stored page text, chosen once per run; see the module header for which text version. */
export type FilePages = {
  fileId: string;
  slug: string;
  /** The version these are the pages of. */
  versionNumber: number;
  /** The stamp a link written against these pages carries (`pageStampFor`). */
  stamp: PageStamp;
  pageCount: number;
  textVersion: string | null;
  /** The labels the file itself gives, one per sheet ([] for none), which a `p` is matched against; null where nothing asked for them. */
  ownLabels: readonly string[] | null;
  pages: Map<number, { text: string; skeleton: Skeleton }>;
};

/**
 * Why a page names no sheet: past the end for a sheet, or for a `p=N` on a
 * file without usable labels, where it is a sheet number; a label no sheet
 * carries otherwise.
 */
function noSheetFor(page: PageName, ownLabels: readonly string[] | null, pageCount: number): "page-out-of-range" | "no-such-label" {
  if ("sheet" in page) return "page-out-of-range";
  return !usablePageLabels(ownLabels, pageCount) && /^\d+$/.test(page.label) ? "page-out-of-range" : "no-such-label";
}

/** A page link's page against its file. */
export function checkPage(file: Pick<FilePages, "versionNumber" | "pageCount">, ownLabels: readonly string[] | null, page: PageName): PageLinkFinding {
  const { versionNumber: version, pageCount } = file;
  const sheets = sheetsNamed(page, ownLabels, pageCount);
  if (sheets.length > 0) return { kind: "ok", version, sheet: sheets[0] + 1 };
  return noSheetFor(page, ownLabels, pageCount) === "page-out-of-range" ? { kind: "page-out-of-range", version, pageCount } : { kind: "no-such-label", version };
}

/**
 * One passage against its file's pages: found on the first of the sheets its
 * page names that holds it, which is §4's "first occurrence wins" extended
 * across the sheets a repeated label names.
 */
export function checkPassage(file: FilePages, passage: FragmentPassage): Exclude<PassageFinding, VersionFault> {
  const version = file.versionNumber;
  const sheets = sheetsNamed(passage.page, file.ownLabels, file.pageCount);
  if (sheets.length === 0) {
    return noSheetFor(passage.page, file.ownLabels, file.pageCount) === "page-out-of-range"
      ? { kind: "page-out-of-range", passage, version, pageCount: file.pageCount }
      : { kind: "no-such-label", passage, version, foundOnPage: passageElsewhere(file, passage, []) };
  }
  for (const index of sheets) {
    const page = file.pages.get(index);
    const range = page ? resolvePassage(page.text, passage, page.skeleton) : null;
    if (page && range) {
      return {
        kind: "ok",
        passage,
        version,
        sheet: index + 1,
        text: page.text.slice(range.start, range.end),
        occurrences: countPassageOccurrences(page.text, passage, page.skeleton),
      };
    }
  }
  const first = file.pages.get(sheets[0]);
  return {
    kind: "no-match",
    passage,
    version,
    sheets: sheets.map((index) => index + 1),
    ...(first ? whereItStops(first.text, first.skeleton, passage) : { matchedUpTo: null, pageHasThere: null }),
    foundOnPage: passageElsewhere(file, passage, sheets),
  };
}

/**
 * One passage looked for on the given 0-based sheets of a file, in order:
 * what a link carried to them comes to (docs/PDF.md §13, "Links into the
 * file"). The sheets are the ones its page's counterparts are, and no label
 * is read. A miss says where the passage is instead, as `checkPassage`'s
 * does, and with no sheet to look on that is the whole of the answer.
 */
export function checkPassageAt(file: FilePages, passage: FragmentPassage, sheets: readonly number[]): Extract<PassageFinding, { kind: "ok" | "no-match" }> {
  const version = file.versionNumber;
  for (const index of sheets) {
    const page = file.pages.get(index);
    const range = page ? resolvePassage(page.text, passage, page.skeleton) : null;
    if (page && range) {
      return { kind: "ok", passage, version, sheet: index + 1, text: page.text.slice(range.start, range.end), occurrences: countPassageOccurrences(page.text, passage, page.skeleton) };
    }
  }
  const first = sheets.length > 0 ? file.pages.get(sheets[0]) : undefined;
  return {
    kind: "no-match",
    passage,
    version,
    sheets: sheets.map((index) => index + 1),
    ...(first ? whereItStops(first.text, first.skeleton, passage) : { matchedUpTo: null, pageHasThere: null }),
    foundOnPage: passageElsewhere(file, passage, sheets),
  };
}

/**
 * What the check reads a file's versions through, so the reading below is
 * one function for the database's pages and for a test's
 * (src/lib/pdf-fragment-check.ts implements it over stored page text).
 */
export type PassageSource = {
  /** A passage read on one version by the page it names there. A fault for a version with nothing to read; null for no such file. */
  onVersion(version: number, passage: FragmentPassage): Promise<PassageFinding | null>;
  /** A passage looked for on these 0-based sheets of a version (`checkPassageAt`). */
  onSheets(version: number, passage: FragmentPassage, sheets: readonly number[]): Promise<Extract<PassageFinding, { kind: "ok" | "no-match" }> | null>;
  /** Whether any of these 0-based sheets of a version holds the passage. */
  held(version: number, passage: PassageText, sheets: readonly number[]): Promise<boolean>;
  /** A page link's page on one version. */
  pageOnVersion(version: number, page: PageName): Promise<PageLinkFinding | null>;
};

/**
 * One passage of a link, **read as the viewer reads it** and checked where
 * it lands (docs/PDF.md §13, "Links into the file"). `reading` is its page's
 * (`readPage`), and `shown` the version its address shows.
 *
 * - It names the version shown, or one no page map joins to it: checked on
 *   the version it names, which is the one it opens.
 * - It is carried: checked on the sheets it lands on. Words that aren't
 *   there are a miss on the version shown, and the finding says whether the
 *   version the link names holds them, which is what a better copy's
 *   correction looks like.
 * - Its sheet has no counterpart: it is carried only by its words, where
 *   they occur exactly once in the version shown. Otherwise it isn't
 *   carried, and is checked on the version it names.
 * - It names an abandoned version that can't be carried off, or a version
 *   the file never had: the fault that says which.
 */
export async function readPassage(passage: FragmentPassage, reading: PageReading, shown: number, source: PassageSource): Promise<PassageFinding | null> {
  if (reading.kind === "here" || reading.kind === "elsewhere") return source.onVersion(reading.version, passage);
  if (reading.kind === "abandoned") return { kind: "abandoned-version", version: reading.version, passage };
  if (reading.kind === "no-such-version") return { kind: "no-such-version", version: reading.version, passage };
  const landed = await source.onSheets(shown, passage, reading.sheets);
  if (!landed) return null;
  if (landed.kind === "ok") return { ...landed, carried: { from: reading.version } };
  if (reading.sheets.length > 0) {
    const namedHolds = reading.state !== "abandoned" && (await source.held(reading.version, passage, reading.named));
    return { ...landed, carried: { from: reading.version, namedHolds } };
  }
  const byWords = landed.foundOnPage !== null ? await source.onSheets(shown, passage, [landed.foundOnPage - 1]) : null;
  if (byWords?.kind === "ok") return { ...byWords, carried: { from: reading.version, byWords: true } };
  if (reading.state === "abandoned") return { kind: "abandoned-version", version: reading.version, mapped: true, passage };
  return source.onVersion(reading.version, passage);
}

/** A page link's page, read as the viewer reads it: on the version it names, or on the sheet the page maps carry it to. */
export async function readPageLink(page: PageName, reading: PageReading, shown: number, source: PassageSource): Promise<PageLinkFinding | null> {
  if (reading.kind === "here" || reading.kind === "elsewhere") return source.pageOnVersion(reading.version, page);
  if (reading.kind === "abandoned") return { kind: "abandoned-version", version: reading.version };
  if (reading.kind === "no-such-version") return { kind: "no-such-version", version: reading.version };
  if (reading.sheets.length > 0) return { kind: "ok", version: shown, sheet: reading.sheets[0] + 1, carried: { from: reading.version } };
  // A link without words whose sheet has no counterpart is not carried: it opens the version it names.
  if (reading.state === "abandoned") return { kind: "abandoned-version", version: reading.version, mapped: true };
  return source.pageOnVersion(reading.version, page);
}

/** The 1-based page holding the passage when exactly one page outside `named` (0-based) does, once: `foundOnPage`, and the viewer's question when it misses (§6). */
export function passageElsewhere(file: Pick<FilePages, "pages">, passage: PassageText, named: readonly number[]): number | null {
  let found: number | null = null;
  for (const [pageIndex, page] of file.pages) {
    if (named.includes(pageIndex)) continue;
    const count = countPassageOccurrences(page.text, passage, page.skeleton);
    if (count === 0) continue;
    if (count > 1 || found !== null) return null;
    found = pageIndex + 1;
  }
  return found;
}

// How much of the page to show either side of where a match stops.
const CONTEXT = 40;

/**
 * Where a missed passage stops matching: the longest leading stretch of the
 * part that failed, and what the page has right after it. The parts are
 * walked in order, each looked for after the one before it, as the matcher
 * walks a passage's segments (§2): a segment's `start`, then its `end`, then
 * the next segment. That is the answer an author needs: the word the PDF
 * spells differently, a footnote number in the way, a page break, or a
 * segment the page holds only before the one it follows.
 */
function whereItStops(
  text: string,
  sk: Skeleton,
  passage: PassageText,
): { matchedUpTo: string | null; pageHasThere: string | null } {
  const parts = passage.segments.flatMap((segment) => [segment.start, ...(segment.end !== null ? [segment.end] : [])]);
  let key: string | null = null;
  let from = 0;
  for (const part of parts) {
    const partKey = skeletonOf(part).text;
    const at = sk.text.indexOf(partKey, from);
    if (at < 0) {
      key = partKey;
      break;
    }
    from = at + partKey.length;
  }
  // Every part is there in order: the miss is a word boundary, a prefix or a
  // suffix, and the answer is the first part, found whole.
  if (key === null) {
    key = skeletonOf(passage.segments[0].start).text;
    from = 0;
  }
  // The longest prefix of `key` the page holds, found by halving.
  let low = 0;
  let high = key.length;
  let at = -1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const found = sk.text.indexOf(key.slice(0, mid), from);
    if (found >= 0) {
      low = mid;
      at = found;
    } else {
      high = mid - 1;
    }
  }
  if (low === 0 || at < 0) return { matchedUpTo: null, pageHasThere: null };
  const matchStart = sk.starts[at];
  const matchEnd = sk.ends[at + low - 1];
  return {
    matchedUpTo: text.slice(Math.max(matchStart, matchEnd - CONTEXT), matchEnd),
    pageHasThere: text.slice(matchEnd, matchEnd + CONTEXT),
  };
}

/** Every link mark's href in a ProseMirror JSON body, in document order. */
export function linkHrefsIn(json: unknown): string[] {
  const hrefs: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as { marks?: unknown; content?: unknown };
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        const href = (mark as { type?: unknown; attrs?: { href?: unknown } })?.attrs?.href;
        if ((mark as { type?: unknown }).type === "link" && typeof href === "string") hrefs.push(href);
      }
    }
    if (Array.isArray(record.content)) record.content.forEach(walk);
  };
  walk(json);
  return hrefs;
}
