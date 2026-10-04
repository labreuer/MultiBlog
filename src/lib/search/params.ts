// docs/FULLTEXT.md §6 — the search's parameters, parsed from a querystring and
// written back into one.
//
// Pure and browser-safe: no Prisma, no session. Nothing here decides what a
// viewer may see. An author slug is accepted here only as well-formed, and the
// loader then keeps the ones on this viewer's picker (authors.ts), the way
// /docs checks its own against its option list. The page and the API (§8) both
// go through this parser, so the two can't read the same URL differently.

/** The five kinds, in the order the page shows their sections (§7). */
export const SEARCH_KINDS = ["docs", "posts", "pdfs", "annotations", "comments"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** `searchQuotableTargets` capped its input at the same length. */
export const MAX_QUERY_LENGTH = 200;

/** Days as the form sends them, `YYYY-MM-DD`, each end inclusive. */
export type DayRange = { from: string | null; to: string | null };

export type SearchParams = {
  /** Trimmed and capped; "" means no text, which lists rather than matches (§4). */
  q: string;
  /** The kinds asked for, in page order; null when none were named, meaning every kind the viewer can read. */
  kinds: SearchKind[] | null;
  /** User slugs, well-formed but not yet checked against the picker. */
  authors: string[];
  created: DayRange;
  updated: DayRange;
  /** An IANA zone `Intl` accepts. The days above are days in it. */
  tz: string;
  /** 1-based. Meaningful only when exactly one kind is selected. */
  page: number;
  /** `exact=1` turns typo correction off (§5). */
  exact: boolean;
};

export const DEFAULT_TIME_ZONE = "UTC";

// A value can arrive comma-joined (`kinds=docs,posts`, how this file writes
// one) or repeated (`kinds=docs&kinds=posts`, how a plain GET form with
// checkboxes submits one). Both read the same.
function listParam(params: URLSearchParams, name: string): string[] {
  return params
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseKinds(params: URLSearchParams): SearchKind[] | null {
  const wanted = new Set(listParam(params, "kinds"));
  const kinds = SEARCH_KINDS.filter((kind) => wanted.has(kind));
  return kinds.length > 0 ? kinds : null;
}

// The shape of a user slug (src/lib/slug.ts makes them): lowercase letters,
// digits and hyphens. Anything else can name no user, so it is dropped here
// rather than carried into a query.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseAuthors(params: URLSearchParams): string[] {
  return [...new Set(listParam(params, "authors").filter((slug) => SLUG_RE.test(slug)))];
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` naming a real calendar day, or null. */
export function parseDay(value: string | null | undefined): string | null {
  const match = value ? DAY_RE.exec(value.trim()) : null;
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 2026-02-30 over into March; a round trip catches it.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return match[0];
}

/** Whether `Intl` knows this zone. `new Intl.DateTimeFormat` throws a RangeError for one it doesn't. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseTimeZone(value: string | null): string {
  const zone = value?.trim();
  return zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * A Next page's resolved `searchParams` as URLSearchParams, **keeping every
 * value of a repeated name** — what a plain submit of the form's checkboxes
 * sends. The admin tables' `toURLSearchParams` keeps only the first, which
 * is right for them and would drop all but one checked box here.
 */
export function urlSearchParamsFrom(resolved: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(resolved)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(name, one);
  }
  return params;
}

export function parseSearchParams(params: URLSearchParams): SearchParams {
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH).trim(),
    kinds: parseKinds(params),
    authors: parseAuthors(params),
    created: { from: parseDay(params.get("created_from")), to: parseDay(params.get("created_to")) },
    updated: { from: parseDay(params.get("updated_from")), to: parseDay(params.get("updated_to")) },
    tz: parseTimeZone(params.get("tz")),
    page: parsePage(params.get("page")),
    exact: params.get("exact") === "1",
  };
}

/** Whether any filter narrows the search — what lets an empty `q` list rather than show nothing (§4). */
export function hasFilters(params: SearchParams): boolean {
  return (
    params.kinds !== null ||
    params.authors.length > 0 ||
    params.created.from !== null ||
    params.created.to !== null ||
    params.updated.from !== null ||
    params.updated.to !== null
  );
}

/**
 * The querystring that reproduces `params`, with `changes` applied. What every
 * link the page builds goes through — "All N docs", pagination, "search
 * exactly as typed" — so none of them drops a filter the reader had set.
 *
 * Defaults are left out, so a link carries only what was chosen. `tz` is kept
 * only beside a date, the one thing it changes the meaning of.
 */
export function searchQueryString(params: SearchParams, changes: Partial<SearchParams> = {}): string {
  const next = { ...params, ...changes };
  const out = new URLSearchParams();
  if (next.q) out.set("q", next.q);
  if (next.kinds) out.set("kinds", next.kinds.join(","));
  if (next.authors.length > 0) out.set("authors", next.authors.join(","));
  const dates: [string, string | null][] = [
    ["created_from", next.created.from],
    ["created_to", next.created.to],
    ["updated_from", next.updated.from],
    ["updated_to", next.updated.to],
  ];
  for (const [name, value] of dates) if (value) out.set(name, value);
  if (dates.some(([, value]) => value) && next.tz !== DEFAULT_TIME_ZONE) out.set("tz", next.tz);
  if (next.page > 1) out.set("page", String(next.page));
  if (next.exact) out.set("exact", "1");
  const query = out.toString();
  return query ? `?${query}` : "";
}
