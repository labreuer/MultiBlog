import { firstPage, isPageLocator, normalizeLocator } from "./entity-chips/kinds/citation";
import { parsePassageText, type PassageText } from "./pdf-fragment";

// docs/CITATIONS.md, "The link" — what a citation's link at a page carries
// beyond the page: `/references/<key>/p/<page>?<query>`. The cited-page
// route reads it, and so do the integrity check and MCP's write check, which
// read a post's frozen copy of the same href. Pure and isomorphic, so its
// rejection surface is a unit test; src/lib/cited-passage.ts is the half
// that reads the pages.

/** What a citation's query asks of the work's PDF. */
export type CitedQuery =
  /** A `/pdf/` referent's own page and `text` pairs, as it wrote them: the PDF's fragment, as it is. */
  | { kind: "pairs"; fragment: string }
  /** The quotation beside the citation, as one `text` value, its brackets still to settle against the page. */
  | { kind: "quotation"; text: PassageText }
  /** No query, or nothing in it for the PDF. */
  | { kind: "none" }
  /** A `text` that doesn't parse. */
  | { kind: "unreadable" };

const PAGE_PARAM = /^(?:sheet|page|p)=/;
// What a `/pdf/` referent's pairs keep besides their pages: each page's `v`, which says whose sheets it counts (docs/PDF.md §13), and its `text`s.
const PAIR_PARAM = /^(?:sheet|page|p|v|text)=/;

/**
 * A citation's query, as it arrived (still percent-encoded, no `?`), as the
 * fragment grammar reads it (docs/PDF_FRAGMENT_LINKS.md §2): with a page, the
 * `sheet`, `page`, `p`, `v` and `text` parameters in order, the fragment a `/pdf/` referent
 * gave; with a `text` alone, the quotation, read before decoding as a
 * fragment's is.
 *
 * One difference from a fragment: a comma is syntax encoded or not. The
 * server hands a route its query with every comma encoded (`%2C`, measured
 * against `next dev`), so one written as a separator can't be told from one
 * written as text there, and writers never encode one.
 */
export function parseCitedQuery(query: string): CitedQuery {
  const params = query.replace(/^\?/, "").replace(/%2C/gi, ",").split("&").filter(Boolean);
  if (params.some((param) => PAGE_PARAM.test(param))) {
    return { kind: "pairs", fragment: params.filter((param) => PAIR_PARAM.test(param)).join("&") };
  }
  const text = params.find((param) => param.startsWith("text="));
  if (text === undefined) return { kind: "none" };
  const passage = parsePassageText(text.slice("text=".length));
  return passage ? { kind: "quotation", text: passage } : { kind: "unreadable" };
}

/**
 * The first and last page a cited page names: the path's locator, one page
 * or, for a quotation over several, the whole locator (`49–50`, `49, 51`),
 * which says how far the quotation may run. Null for anything that isn't
 * pages.
 */
export function citedPages(page: string): { first: string; last: string } | null {
  if (!isPageLocator(page)) return null;
  const locator = normalizeLocator(page);
  const pages = locator.split(/[–,]/).map((part) => part.trim());
  return { first: firstPage(locator), last: pages[pages.length - 1] };
}

/** A citation's link at a page, with a query: the reference's path segment and page, decoded, and the query raw. */
export type CitedHref = { segment: string; page: string; query: string };

// Resolves a relative href; never fetched.
const PROBE_ORIGIN = "https://cited-passage.invalid";

/**
 * An href to `/references/<key>/p/<page>` with a query, written relative or
 * absolute on `siteOrigin`: a post's frozen copy of a citation's link, or the
 * link a doc's citation renders. Null for anything else, a citation's link
 * with no query included, since it names no passage.
 */
export function parseCitedHref(href: string, siteOrigin: string | null): CitedHref | null {
  let url: URL;
  try {
    if (href.startsWith("/") && !href.startsWith("//")) url = new URL(href, PROBE_ORIGIN);
    else {
      if (!siteOrigin) return null;
      url = new URL(href);
      if (url.origin !== new URL(siteOrigin).origin) return null;
    }
  } catch {
    return null;
  }
  const match = /^\/references\/([^/]+)\/p\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || url.search.length <= 1) return null;
  try {
    return { segment: decodeURIComponent(match[1]), page: decodeURIComponent(match[2]), query: url.search.slice(1) };
  } catch {
    return null;
  }
}
