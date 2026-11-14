// docs/PDF.md §13, "Links into the file" — how a link into a PDF is read
// against the file's versions: which version each of its pages names, and
// what a reader on a given address is shown for it. The viewer, the
// cited-page route, MCP and the checks all read a link here, so none of them
// lands it on a version another would not.
//
// **A link is carried from the version it names to the version shown**,
// through the page map of each version between them (`carrySheet`,
// src/lib/pdf-page-map.ts). One that can't be carried, because a map on the
// way is missing, opens the version it names.
//
// Pure and browser-safe, so the reading is a unit test.

import { pageStampFor, pdfPath, type FileVersionState } from "./file-version";
import { formatFragmentPassages, parseFragmentPassages, type PassageText } from "./pdf-fragment";
import { formatPageName, pageFromHash, type PageName, type PageStamp } from "./pdf-open-params";
import { sheetsNamed } from "./pdf-page-labels";
import { carrySheet, mapsJoin, type SheetPairs } from "./pdf-page-map";

/**
 * A version of the file, as much of it as a link's reading needs. Its number
 * and state decide which version a link names and whether that version can
 * be opened. The rest is what carrying reads, and is absent where the file's
 * versions have no map between them:
 *
 * - `base` and `map`: the version it was uploaded over, and the pairing of
 *   its page map from that version (`PageMap.sheets`);
 * - `pageCount` and `labels`: its sheets and the labels its file gives them,
 *   by which a `p=` that names it is turned into sheets.
 */
export type LinkVersion = {
  number: number;
  state: FileVersionState;
  base?: number | null;
  map?: SheetPairs | null;
  pageCount?: number | null;
  labels?: readonly string[] | null;
};

/**
 * A file's versions as one string, and back: what a server page hands a
 * client component, which keys a memo or an effect on it. A list handed over
 * as a prop has a new identity on every refresh, and a reading that re-ran
 * with it would jump the reader back to a linked passage whenever anything
 * on the page was saved. A string is equal to itself.
 */
export function linkVersionsJson(versions: readonly LinkVersion[]): string {
  return JSON.stringify(versions);
}

export function parseLinkVersions(json: string): LinkVersion[] {
  return JSON.parse(json) as LinkVersion[];
}

/**
 * The address a link is read on: the version it shows, and whether the
 * address is that version's own (`/pdf/<slug>/v/<n>`), which has already said
 * which version an unstamped link names, or the bare one.
 */
export type LinkAddress = { shown: number; own: boolean };

/**
 * The version a page names: its `v=`, or without one the file's first
 * version, always, since that holds for every link written before a file's
 * second version existed. **On a version's own address a link without `v=`
 * names that version**, the one place an unstamped link is not read as the
 * first.
 */
export function namedVersion(page: PageName, address: LinkAddress): number {
  return page.v ?? (address.own ? address.shown : 1);
}

/** What a page of a link comes to on the address it is read on. */
export type PageReading =
  /** It names the version shown: read on its sheets as written. */
  | { kind: "here"; version: number }
  /**
   * It names another version, and page maps join that version to the one
   * shown. `named` are the sheets it names on its own version and `sheets`
   * their counterparts on the version shown, both 0-based and in order.
   * `sheets` is empty where none has a counterpart: the link is then carried
   * only by its words, where they occur exactly once in the version shown.
   */
  | { kind: "carried"; version: number; state: FileVersionState; named: number[]; sheets: number[] }
  /** It names another version, which can be opened, and a page map on the way to the one shown is missing. */
  | { kind: "elsewhere"; version: number; state: Exclude<FileVersionState, "abandoned"> }
  /** It names an abandoned version, which no page maps join to the one shown: there is no version to open instead. */
  | { kind: "abandoned"; version: number }
  /** It names a version the file never had. */
  | { kind: "no-such-version"; version: number };

export function readPage(page: PageName, address: LinkAddress, versions: readonly LinkVersion[]): PageReading {
  const version = namedVersion(page, address);
  if (version === address.shown) return { kind: "here", version };
  const named = versions.find((candidate) => candidate.number === version);
  if (!named) return { kind: "no-such-version", version };
  if (mapsJoin(version, address.shown, versions)) {
    // A `p=` is carried as a `sheet=` is: the sheets carrying its label on
    // the version it names each go through the maps.
    const namedSheets = named.pageCount != null ? sheetsNamed(page, named.labels ?? null, named.pageCount) : "sheet" in page ? [page.sheet - 1] : [];
    const sheets: number[] = [];
    for (const sheet of namedSheets) {
      const carried = carrySheet(sheet, version, address.shown, versions);
      if (carried.kind === "carried" && !sheets.includes(carried.sheet)) sheets.push(carried.sheet);
    }
    return { kind: "carried", version, state: named.state, named: namedSheets, sheets };
  }
  if (named.state === "abandoned") return { kind: "abandoned", version };
  return { kind: "elsewhere", version, state: named.state };
}

/**
 * Whether a reading's passage is looked for by its words alone, anywhere in
 * the version shown, with no map behind it: the two cases with no version to
 * open instead. It is drawn where the words occur exactly once, and the
 * banner says so.
 */
export function readByWordsAlone(reading: PageReading): boolean {
  return reading.kind === "abandoned" || reading.kind === "no-such-version";
}

/**
 * The sheet the viewer opens at for a page, before any passage is found:
 *
 * - `"as-written"` when the page names the version shown, and when it names
 *   a version the file never had, which opens the sheet as written under a
 *   banner;
 * - the 1-based sheet a carried page reaches, the first of them;
 * - null for a page that names sheets of other bytes and was brought to none
 *   here: one of an abandoned version, of another version read on an address
 *   that has already chosen its own, or one whose sheet has no counterpart.
 */
export function openingOf(reading: PageReading): "as-written" | number | null {
  if (reading.kind === "here" || reading.kind === "no-such-version") return "as-written";
  return reading.kind === "carried" && reading.sheets.length > 0 ? reading.sheets[0] + 1 : null;
}

/**
 * Whether a page carried to the 0-based sheet `landed` opens another sheet
 * than it would if it were simply read on the version shown, whose own labels
 * and sheet count these are. A link carried to a sheet of the same number, or
 * a `p=` to a sheet that carries its label here too, opens as it always did,
 * and the viewer says nothing of it: after a corrected scan that is nearly
 * every link into the file.
 */
export function carriedElsewhere(page: PageName, landed: number, ownLabels: readonly string[] | null | undefined, pageCount: number): boolean {
  return !sheetsNamed(page, ownLabels, pageCount).includes(landed);
}

/**
 * What a link read on the **bare address** does on arrival, decided before
 * the viewer mounts:
 *
 * - `stay`: it is shown here, as written or carried;
 * - `open`: it can't be carried, and the viewer goes to the own address of
 *   the version it names, with the link as written, replacing the history
 *   entry;
 * - `by-words`: page maps join the two versions and its sheet has no
 *   counterpart here, so it is carried only by its words. It stays where
 *   `passage` occurs exactly once in the version shown, which only the
 *   server can say, and otherwise opens `version`.
 *
 * A link whose passages are stamped with different versions is read by its
 * first, as the viewer's opening sheet is: the others are then read on the
 * address it ends on. On a version's own address the viewer always stays,
 * since the address chose the version. A link that names an abandoned
 * version has no version to open, and stays.
 */
export type Arrival = { kind: "stay" } | { kind: "open"; version: number } | { kind: "by-words"; version: number; passage: PassageText };

export function arrivalOf(fragment: string, address: LinkAddress, versions: readonly LinkVersion[]): Arrival {
  if (address.own) return { kind: "stay" };
  const first = pageFromHash(fragment);
  if (!first) return { kind: "stay" };
  const reading = readPage(first, address, versions);
  if (reading.kind === "elsewhere") return { kind: "open", version: reading.version };
  if (reading.kind !== "carried" || reading.sheets.length > 0 || reading.state === "abandoned") return { kind: "stay" };
  const passage = parseFragmentPassages(fragment)[0];
  if (!passage) return { kind: "open", version: reading.version };
  return { kind: "by-words", version: reading.version, passage: { prefix: passage.prefix, segments: passage.segments, suffix: passage.suffix } };
}

/**
 * The stamp a link's page is written with when the app sends it on: its own
 * `v=` where it has one, kept even on a file with one version, where it then
 * names a version the file lacks and the viewer says so; otherwise the
 * version it names on the address it was read on, once the file has a second
 * version.
 */
export function stampOfRead(page: PageName, address: LinkAddress, versionCount: number): PageStamp {
  return page.v ?? pageStampFor(namedVersion(page, address), versionCount);
}

/**
 * A link's fragment as a writer writes it (`formatPageName`), each page
 * stamped with the version it names on `address`: what the cited-page route
 * redirects with, and what the viewer offers on another version's address.
 * A `page=` so leaves as `sheet=`. A fragment with `text` is written passage
 * by passage, and one without as its page alone. Null for a fragment that
 * names no page. Without its `#`.
 */
export function stampedFragment(fragment: string, address: LinkAddress, versionCount: number): string | null {
  const passages = parseFragmentPassages(fragment);
  if (passages.length > 0) {
    return formatFragmentPassages(passages.map((passage) => ({ ...passage, page: { ...passage.page, stamp: stampOfRead(passage.page, address, versionCount) } })));
  }
  const page = pageFromHash(fragment);
  return page ? formatPageName({ ...page, stamp: stampOfRead(page, address, versionCount) }) : null;
}

/**
 * Where a link's pairs send a reader who follows them from outside the
 * viewer, as the cited-page route does for a `/pdf/` referent (docs/PDF.md
 * §13, "Links into the file"): read as the viewer reads a link on the bare
 * address, and **carried here, on the server**, so the reader arrives on the
 * latest with what was found. Each page names the version its `v=` says, or
 * the file's first.
 *
 * - Pairs that name the latest open there, as written.
 * - Pairs the page maps bring to the latest are written for it: the sheet
 *   each landed on, stamped with the latest. `find` says where a passage is
 *   among the 0-based sheets its page was carried to, or, failing that, the
 *   one sheet of the latest that holds it once. A passage it doesn't find is
 *   left as written, for the viewer to report and to offer on the version it
 *   names.
 * - Pairs that can't be carried open the version they name: a map on the way
 *   is missing, or the sheet has no counterpart and the words aren't found.
 *   The link goes by its first page, as the viewer does.
 * - Pairs whose version is abandoned or was never the file's go to the bare
 *   address, where the viewer says so.
 *
 * Every pair is written anew (`formatPageName`), so a `page=` leaves as
 * `sheet=` and every page carries its stamp once the file has a second
 * version. Null where the pairs name no page.
 */
export async function referentTarget(
  slug: string,
  fragment: string,
  latestNumber: number,
  versions: readonly LinkVersion[],
  find: (passage: PassageText, sheets: readonly number[]) => Promise<number | null> = async () => null,
): Promise<string | null> {
  const address = { shown: latestNumber, own: false };
  const asWritten = stampedFragment(fragment, address, versions.length);
  if (asWritten === null) return null;
  const onVersion = (version: number) => `${pdfPath(slug, { number: version, isLatest: false })}#${asWritten}`;
  const latestStamp = pageStampFor(latestNumber, versions.length);

  const passages = parseFragmentPassages(fragment);
  if (passages.length === 0) {
    const page = pageFromHash(fragment)!;
    const reading = readPage(page, address, versions);
    if (reading.kind === "elsewhere") return onVersion(reading.version);
    if (reading.kind !== "carried") return `${pdfPath(slug)}#${asWritten}`;
    if (reading.sheets.length > 0) return `${pdfPath(slug)}#${formatPageName({ sheet: reading.sheets[0] + 1, stamp: latestStamp })}`;
    return reading.state === "abandoned" ? `${pdfPath(slug)}#${asWritten}` : onVersion(reading.version);
  }

  const written = [];
  for (const [index, passage] of passages.entries()) {
    const reading = readPage(passage.page, address, versions);
    if (index === 0 && reading.kind === "elsewhere") return onVersion(reading.version);
    const found = reading.kind === "carried" ? await find(passage, reading.sheets) : null;
    // A first passage with no counterpart and no words to be found by is not carried.
    if (index === 0 && reading.kind === "carried" && found === null && reading.sheets.length === 0 && reading.state !== "abandoned") return onVersion(reading.version);
    written.push({
      ...passage,
      page: found !== null ? { sheet: found + 1, stamp: latestStamp } : { ...passage.page, stamp: stampOfRead(passage.page, address, versions.length) },
    });
  }
  return `${pdfPath(slug)}#${formatFragmentPassages(written)}`;
}
