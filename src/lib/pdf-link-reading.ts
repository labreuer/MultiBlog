// docs/PDF.md §13, "Links into the file" — how a link into a PDF is read
// against the file's versions: which version each of its pages names, and
// what a reader on a given address is shown for it. The viewer, the
// cited-page route, MCP and the checks all read a link here, so none of them
// lands it on a version another would not.
//
// **No link is carried yet.** A link is carried from the version it names to
// the version shown through the page map of each version between them, and
// no version has a map, so a link that names another version than the one
// shown opens the version it names. Carrying arrives with the page maps
// (§13, "Building it", step 10) as one more answer of `readPage`, beside
// `elsewhere`, and every reader that goes through `readPage` gains it.
//
// Pure and browser-safe, so the reading is a unit test.

import { pageStampFor, type FileVersionState } from "./file-version";
import { formatFragmentPassages, parseFragmentPassages } from "./pdf-fragment";
import { formatPageName, pageFromHash, type PageName, type PageStamp } from "./pdf-open-params";

/** A version of the file, as much of it as a link's reading needs. */
export type LinkVersion = { number: number; state: FileVersionState };

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
  /** It names another version, which can be opened, and no page map brings it to the one shown. */
  | { kind: "elsewhere"; version: number; state: Exclude<FileVersionState, "abandoned"> }
  /** It names an abandoned version, which kept no page map: there is no version to open instead. */
  | { kind: "abandoned"; version: number }
  /** It names a version the file never had. */
  | { kind: "no-such-version"; version: number };

export function readPage(page: PageName, address: LinkAddress, versions: readonly LinkVersion[]): PageReading {
  const version = namedVersion(page, address);
  if (version === address.shown) return { kind: "here", version };
  const named = versions.find((candidate) => candidate.number === version);
  if (!named) return { kind: "no-such-version", version };
  if (named.state === "abandoned") return { kind: "abandoned", version };
  return { kind: "elsewhere", version, state: named.state };
}

/**
 * Whether a reading's passage is looked for by its words alone, anywhere in
 * the version shown: the two cases with no version to open instead. It is
 * drawn where the words occur exactly once, and the banner says so.
 */
export function readByWordsAlone(reading: PageReading): boolean {
  return reading.kind === "abandoned" || reading.kind === "no-such-version";
}

/**
 * Whether the viewer opens at the sheet a page names: when the page names the
 * version shown, and when it names a version the file never had, which opens
 * the sheet as written under a banner. A page of an abandoned version, or of
 * another version read on an address that has already chosen its own, names a
 * sheet of other bytes, and is sent nowhere.
 */
export function opensSheetAsWritten(reading: PageReading): boolean {
  return reading.kind === "here" || reading.kind === "no-such-version";
}

/**
 * Where a link read on the **bare address** goes, when it isn't shown there:
 * the number of the version whose own address the viewer goes to, with the
 * link as written, replacing the history entry; null to stay.
 *
 * It goes where its first page names another version that can be opened.
 * A link whose passages are stamped with different versions is read by its
 * first, as the viewer's opening sheet is: the others are then read on that
 * version's own address, where each that names another version is offered at
 * that version's address. On a version's own address the viewer always
 * stays, since the address chose the version.
 */
export function versionToOpen(fragment: string, address: LinkAddress, versions: readonly LinkVersion[]): number | null {
  if (address.own) return null;
  const first = pageFromHash(fragment);
  if (!first) return null;
  const reading = readPage(first, address, versions);
  return reading.kind === "elsewhere" ? reading.version : null;
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
