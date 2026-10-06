import { prisma } from "./prisma";
import { resolveFileParam } from "./file-slug";
import { currentTextVersion } from "./pdf-extract";
import {
  countPassageOccurrences,
  parseFragmentPassages,
  resolvePassage,
  skeletonOf,
  type FragmentPassage,
  type Skeleton,
} from "./pdf-fragment";

// docs/PDF_FRAGMENT_LINKS.md §8 — the check every confirmation of a fragment
// link shares: the integrity script, run over everything or one doc, and the
// one-quote CLI. It resolves each passage against the file's stored page
// text, the text the viewer's own extraction reproduces, and says what it
// found.
//
// **Server-only, and it reads as the operator.** Both callers are scripts
// holding the database's credentials, where a read gate protects nothing. A
// front door that reads as a user (the MCP server, MCP.md §8) must ask
// `canUserReadFile` before calling in, and answer a file the user can't read
// as not found, or the check becomes a way to ask what a PRIVATE file says.
//
// **Read-only.** `storedPageText` extracts a file lazily when its text is
// missing at the current version; this doesn't, so a check never writes.
// It reads the current version where the file has one, and otherwise the
// newest it has, as search does (docs/FULLTEXT.md §4): a skeleton barely
// depends on the version (src/lib/pdf-fragment.ts), so either answers.

/** How a fragment link's href names its file and passages. Null when the href is not one. */
export type FragmentLinkHref = {
  slug: string;
  passages: FragmentPassage[];
  /** `text` parameters the grammar couldn't read, or that named no page, or came past the limit. */
  unread: number;
};

// Resolves a relative href; never fetched.
const PROBE_ORIGIN = "https://fragment-check.invalid";

/**
 * A fragment link's slug and passages: an href to `/pdf/<slug>` whose
 * fragment has at least one `text` parameter, written relative or absolute
 * on `siteOrigin`. A link to a PDF with only `#page=`, or none, is a page
 * link, and null here.
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
  if (textParams === 0) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const passages = parseFragmentPassages(url.hash);
  return { slug, passages, unread: textParams - passages.length };
}

export type PassageFinding =
  | {
      kind: "ok";
      passage: FragmentPassage;
      /** The page's text at the match. */
      text: string;
      /** How many places on the page this form finds; above 1, the link points at the first. */
      occurrences: number;
    }
  | {
      kind: "no-match";
      passage: FragmentPassage;
      /** The longest stretch of the passage the page holds, and what the page has right after it. */
      matchedUpTo: string | null;
      pageHasThere: string | null;
      /** The 1-based page the passage is on instead, when it occurs exactly once elsewhere in the file. */
      foundOnPage: number | null;
    }
  | { kind: "page-out-of-range"; passage: FragmentPassage; pageCount: number };

export type FragmentLinkFinding =
  | { kind: "unknown-file"; slug: string }
  | {
      kind: "checked";
      slug: string;
      /** The file's slug now; different from `slug` when the link names a past one. */
      currentSlug: string;
      fileId: string;
      passages: PassageFinding[];
      unread: number;
    };

/** A file's stored page text, chosen once per run; see the module header for which version. */
export type FilePages = {
  fileId: string;
  slug: string;
  pageCount: number;
  textVersion: string | null;
  pages: Map<number, { text: string; skeleton: Skeleton }>;
};

/** Caches each file's pages for one run, so a doc that quotes one book 65 times reads it once. */
export class FragmentChecker {
  private files = new Map<string, Promise<FilePages | null>>();
  private version: Promise<string> | null = null;

  /** The file a slug names now, past slugs followed; null for none, or a deleted one. */
  async pagesFor(slug: string): Promise<FilePages | null> {
    let pending = this.files.get(slug);
    if (!pending) {
      pending = this.load(slug);
      this.files.set(slug, pending);
    }
    return pending;
  }

  private async load(slug: string): Promise<FilePages | null> {
    const resolved = await resolveFileParam(slug, { id: true, slug: true, pageCount: true, deletedByUserId: true });
    if (!resolved || resolved.file.deletedByUserId !== null || resolved.file.pageCount === null) return null;
    const file = resolved.file;

    this.version ??= currentTextVersion();
    const current = await this.version;
    const versions = await prisma.filePageText.groupBy({ by: ["textVersion"], where: { fileId: file.id } });
    const names = versions.map((row) => row.textVersion);
    const textVersion = names.includes(current) ? current : (names.sort().at(-1) ?? null);

    const pages = new Map<number, { text: string; skeleton: Skeleton }>();
    if (textVersion !== null) {
      const rows = await prisma.filePageText.findMany({
        where: { fileId: file.id, textVersion },
        select: { pageIndex: true, text: true },
      });
      for (const row of rows) pages.set(row.pageIndex, { text: row.text, skeleton: skeletonOf(row.text) });
    }
    return { fileId: file.id, slug: file.slug, pageCount: file.pageCount!, textVersion, pages };
  }

  async check(link: FragmentLinkHref): Promise<FragmentLinkFinding> {
    const file = await this.pagesFor(link.slug);
    if (!file) return { kind: "unknown-file", slug: link.slug };
    return {
      kind: "checked",
      slug: link.slug,
      currentSlug: file.slug,
      fileId: file.fileId,
      passages: link.passages.map((passage) => checkPassage(file, passage)),
      unread: link.unread,
    };
  }
}

/** One passage against its file's pages. */
export function checkPassage(file: FilePages, passage: FragmentPassage): PassageFinding {
  const pageIndex = passage.page - 1;
  if (pageIndex >= file.pageCount) return { kind: "page-out-of-range", passage, pageCount: file.pageCount };
  const page = file.pages.get(pageIndex);
  const range = page ? resolvePassage(page.text, passage, page.skeleton) : null;
  if (page && range) {
    return {
      kind: "ok",
      passage,
      text: page.text.slice(range.start, range.end),
      occurrences: countPassageOccurrences(page.text, passage, page.skeleton),
    };
  }
  return {
    kind: "no-match",
    passage,
    ...(page ? whereItStops(page.text, page.skeleton, passage) : { matchedUpTo: null, pageHasThere: null }),
    foundOnPage: elsewhere(file, passage),
  };
}

/** The 1-based page holding the passage when exactly one other page does, once. */
function elsewhere(file: FilePages, passage: FragmentPassage): number | null {
  let found: number | null = null;
  for (const [pageIndex, page] of file.pages) {
    if (pageIndex === passage.page - 1) continue;
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
  passage: FragmentPassage,
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
