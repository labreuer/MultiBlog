import { pageFromHash, type PageName } from "./pdf-open-params";
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
  passages: FragmentPassage[];
  /** A page link's page: an href with a `page` or a `p` and no `text`. Null for a fragment link. */
  page: PageName | null;
  /** `text` parameters the grammar couldn't read, or that named no page, or came past the limit. */
  unread: number;
};

// Resolves a relative href; never fetched.
const PROBE_ORIGIN = "https://fragment-check.invalid";

/**
 * A fragment link's slug and passages: an href to `/pdf/<slug>` whose
 * fragment has at least one `text` parameter, written relative or absolute
 * on `siteOrigin`. One whose fragment has a readable `page` or `p` and no
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
  const match = /^\/pdf\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const textParams = url.hash
    .replace(/^#/, "")
    .split("&")
    .filter((param) => param.startsWith("text=")).length;
  const page = textParams === 0 ? pageFromHash(url.hash) : null;
  if (textParams === 0 && page === null) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (page) return { slug, passages: [], page, unread: 0 };
  const passages = parseFragmentPassages(url.hash);
  return { slug, passages, page: null, unread: textParams - passages.length };
}

export type PassageFinding =
  | {
      kind: "ok";
      passage: FragmentPassage;
      /** The 1-based sheet it was found on: the first of the sheets its page names that holds it. */
      sheet: number;
      /** The page's text at the match. */
      text: string;
      /** How many places on the page this form finds; above 1, the link points at the first. */
      occurrences: number;
    }
  | {
      kind: "no-match";
      passage: FragmentPassage;
      /** The 1-based sheets its page names, in order: one for `page=`, any number for a repeated label. */
      sheets: number[];
      /** The longest stretch of the passage the first of them holds, and what that page has right after it. */
      matchedUpTo: string | null;
      pageHasThere: string | null;
      /** The 1-based page the passage is on instead, when it occurs exactly once elsewhere in the file. */
      foundOnPage: number | null;
    }
  | { kind: "page-out-of-range"; passage: FragmentPassage; pageCount: number }
  | {
      kind: "no-such-label";
      passage: FragmentPassage;
      /** As for a miss: the page the passage is on, when it occurs exactly once in the file. */
      foundOnPage: number | null;
    };

/** What a page link's page comes to. */
export type PageLinkFinding =
  | { kind: "ok"; /** 1-based: the sheet it opens at. */ sheet: number }
  | { kind: "page-out-of-range"; pageCount: number }
  | { kind: "no-such-label" };

export type FragmentLinkFinding =
  | { kind: "unknown-file"; slug: string }
  | {
      kind: "checked";
      slug: string;
      /** The file's slug now; different from `slug` when the link names a past one. */
      currentSlug: string;
      fileId: string;
      passages: PassageFinding[];
      /** A page link's finding; null for a fragment link. */
      page: PageLinkFinding | null;
      /**
       * Whether the file has usable labels, for a link with a `p=`, and null
       * for one without, whose answer needs no labels. A `p=` on a file
       * without them is a sheet number, and would turn into a printed page
       * the day the file gained labels: the warning gives its `page=` form.
       */
      usableLabels: boolean | null;
      unread: number;
    };

/** A file's stored page text, chosen once per run; see the module header for which version. */
export type FilePages = {
  fileId: string;
  slug: string;
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
export function checkPage(pageCount: number, ownLabels: readonly string[] | null, page: PageName): PageLinkFinding {
  const sheets = sheetsNamed(page, ownLabels, pageCount);
  if (sheets.length > 0) return { kind: "ok", sheet: sheets[0] + 1 };
  return noSheetFor(page, ownLabels, pageCount) === "page-out-of-range" ? { kind: "page-out-of-range", pageCount } : { kind: "no-such-label" };
}

/**
 * One passage against its file's pages: found on the first of the sheets its
 * page names that holds it, which is §4's "first occurrence wins" extended
 * across the sheets a repeated label names.
 */
export function checkPassage(file: FilePages, passage: FragmentPassage): PassageFinding {
  const sheets = sheetsNamed(passage.page, file.ownLabels, file.pageCount);
  if (sheets.length === 0) {
    return noSheetFor(passage.page, file.ownLabels, file.pageCount) === "page-out-of-range"
      ? { kind: "page-out-of-range", passage, pageCount: file.pageCount }
      : { kind: "no-such-label", passage, foundOnPage: passageElsewhere(file, passage, []) };
  }
  for (const index of sheets) {
    const page = file.pages.get(index);
    const range = page ? resolvePassage(page.text, passage, page.skeleton) : null;
    if (page && range) {
      return {
        kind: "ok",
        passage,
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
    sheets: sheets.map((index) => index + 1),
    ...(first ? whereItStops(first.text, first.skeleton, passage) : { matchedUpTo: null, pageHasThere: null }),
    foundOnPage: passageElsewhere(file, passage, sheets),
  };
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
 * part that failed (`start`, or `end` when the start is there), and what the
 * page has right after it. That is the answer an author needs: the word the
 * PDF spells differently, a footnote number in the way, a page break.
 */
function whereItStops(
  text: string,
  sk: Skeleton,
  passage: PassageText,
): { matchedUpTo: string | null; pageHasThere: string | null } {
  const startKey = skeletonOf(passage.start).text;
  let key = startKey;
  let from = 0;
  const startAt = sk.text.indexOf(startKey);
  if (startAt >= 0 && passage.end !== null) {
    key = skeletonOf(passage.end).text;
    from = startAt + startKey.length;
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
