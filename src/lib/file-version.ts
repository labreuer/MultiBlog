// docs/PDF.md §13, "Versions" — a file's bytes are its versions' (hash, size,
// type, page count, labels, outline, filename), and `file.current_version_id`
// names the latest. This module is the vocabulary every reader shares: which
// version is the latest, what state a version is in, and how each is named.
//
// Browser-safe: no Prisma and no `node:` import, so a client component may
// take the types and the pure helpers. The queries are in
// `file-version-data.ts`.

/**
 * A file's latest version, as the caller selected it.
 *
 * `current_version_id` is nullable for one step alone, between a file's
 * insert and its first version's inside `recordUpload`'s transaction, and
 * Prisma therefore types the relation as optional. Every reader that means
 * "the latest" unwraps it here, so none handles NULL for itself and a file
 * without one fails loudly (`scripts/integrity/check-file-versions.ts`
 * reports such a file).
 */
export function latestVersionOf<V>(file: { id?: string; currentVersion: V | null }): V {
  if (file.currentVersion === null) {
    throw new Error(`File ${file.id ?? "(unknown)"} has no latest version (docs/PDF.md §13, "Versions").`);
  }
  return file.currentVersion;
}

/**
 * A version's state, read from its row and its file's pointer:
 *
 * - `latest`: the one `/pdf/<slug>` shows;
 * - `earlier`: promoted, and no longer the latest;
 * - `candidate`: neither promoted nor abandoned;
 * - `abandoned`: its row is kept, without its bytes or its page text.
 */
export type FileVersionState = "latest" | "earlier" | "candidate" | "abandoned";

export function fileVersionState(
  version: { id: string; promotedAt: Date | string | null; abandonedAt: Date | string | null },
  currentVersionId: string | null,
): FileVersionState {
  if (version.id === currentVersionId) return "latest";
  if (version.abandonedAt !== null) return "abandoned";
  return version.promotedAt !== null ? "earlier" : "candidate";
}

/**
 * What a version is called wherever it is named: the file's title for the
 * latest, and `<title>, version <n>` for any other. A version's own page
 * names its version whatever its state (`always`).
 */
export function fileVersionTitle(title: string, version: { number: number; isLatest: boolean }, opts: { always?: boolean } = {}): string {
  return version.isLatest && !opts.always ? title : `${title}, version ${version.number}`;
}

/**
 * A version's number as an address or a query writes it: digits alone, from 1,
 * with no sign, no leading zero and nothing after. Null for anything else, so
 * `/v/01` and `/v/1x` are not second addresses of version 1.
 */
export function parseVersionNumber(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,8}$/.test(raw)) return null;
  return Number(raw);
}

/**
 * A version as an address names it: its number, and whether it is the latest.
 * Null is "the file", read at the bare address: a tag, a note with no target,
 * a doc's link to the PDF as a whole.
 */
export type VersionRef = { number: number; isLatest: boolean } | null;

/**
 * The reading address of a file, or of one version of it (docs/PDF.md §13,
 * "Addresses"): `/pdf/<slug>` for the latest, `/pdf/<slug>/v/<n>` for any
 * other. **Every link to a note, a card or a part on a PDF is built here**,
 * from the version that note or part is on (`noteVersions`,
 * file-version-data.ts): one written as a bare `/pdf/${slug}` lands on the
 * note's entry in the list of notes on other versions, and not on its card.
 *
 * `own` is a version's own address whatever its state, the latest's
 * included: what its page, its banner and the version list link.
 */
export function pdfPath(slug: string, version?: VersionRef, opts: { own?: boolean } = {}): string {
  return version && (opts.own || !version.isLatest) ? `/pdf/${slug}/v/${version.number}` : `/pdf/${slug}`;
}

/** A file's download page, or one version's: `/files/<slug>` and `/files/<slug>/v/<n>`. */
export function filesPath(slug: string, version?: VersionRef, opts: { own?: boolean } = {}): string {
  return version && (opts.own || !version.isLatest) ? `/files/${slug}/v/${version.number}` : `/files/${slug}`;
}

/**
 * The version a PDF page shows, as the surface holds it. `address` says which
 * of the file's two kinds of address the page is: the bare one, which means
 * "the latest", or the version's own, which has already said which version.
 * A capture names both, and its write checks them (docs/PDF.md §13,
 * "Versions").
 */
export type ShownVersion = {
  id: string;
  number: number;
  isLatest: boolean;
  state: FileVersionState;
  address: "bare" | "version";
};

const ELAPSED_UNITS: readonly (readonly [string, number])[] = [
  ["year", 365.25 * 86_400_000],
  ["month", 30.4375 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/**
 * The time between two versions' uploads, as a banner says it: in the largest
 * unit that fits (years, months, days, hours, minutes or seconds), rounded to
 * the nearest. "3 months", "1 day", "40 seconds".
 */
export function elapsedInLargestUnit(milliseconds: number): string {
  const span = Math.abs(milliseconds);
  const [unit, size] = ELAPSED_UNITS.find(([, length]) => span >= length) ?? ELAPSED_UNITS[ELAPSED_UNITS.length - 1];
  const count = Math.round(span / size);
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Where a link lands in a file, and what the file is called there, from the
 * versions its parts in that file are on (docs/PDF.md §13, "Addresses"): the
 * newest version holding a part, which is the latest wherever a part is on
 * it. The file stays one group whichever versions its parts are on, so a
 * link that went straight into the PDF before a promotion still does after.
 *
 * `title` names the versions the parts are on wherever one of them is not the
 * latest, the latest included ("Book, versions 1 and 2"): naming the earlier
 * one alone would read as though every part were on it. Parts all on the
 * latest leave the title bare. A reader so sees which bytes a passage was
 * measured on before opening it.
 */
export function linkPartsVersions(
  fileTitle: string,
  partVersions: readonly ({ id: string; number: number } | null | undefined)[],
  currentVersionId: string | null,
): { landing: VersionRef; title: string } {
  const numbered = new Map<number, string>();
  for (const version of partVersions) if (version) numbered.set(version.number, version.id);
  if (numbered.size === 0) return { landing: null, title: fileTitle };
  const numbers = [...numbered.keys()].sort((a, b) => a - b);
  const newest = numbers[numbers.length - 1];
  const others = numbers.filter((number) => numbered.get(number) !== currentVersionId);
  const named =
    others.length === 0
      ? fileTitle
      : `${fileTitle}, version${numbers.length === 1 ? "" : "s"} ${numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(", ")} and ${newest}`}`;
  return { landing: { number: newest, isLatest: numbered.get(newest) === currentVersionId }, title: named };
}

/**
 * A PDF as the container of one note, for a listing of single notes: where
 * the note's card is (`path`, the note's own version's address) and what the
 * file is called there. `version` is the note's, from `noteVersions`; absent
 * for a note that is the file's and has none.
 */
export function pdfNoteContainer(file: { slug: string; title: string }, version: VersionRef | undefined): { path: string; title: string } {
  return { path: pdfPath(file.slug, version ?? null), title: version ? fileVersionTitle(file.title, version) : file.title };
}

/**
 * What a capture says of where it was made: the version its viewer loaded,
 * and the kind of address it loaded it from (docs/PDF.md §13, "Versions").
 * The write checks both inside the transaction that inserts
 * (`assertCaptureVersion`, file-version-data.ts).
 */
export type CaptureOrigin = { fileVersionId: string; address: "bare" | "version" };

/** A capture's origin as a client sent it, or null when it isn't one. Parsed, never cast: a server action is sent whatever its caller likes. */
export function parseCaptureOrigin(raw: unknown): CaptureOrigin | null {
  if (!raw || typeof raw !== "object") return null;
  const { fileVersionId, address } = raw as Record<string, unknown>;
  if (typeof fileVersionId !== "string" || fileVersionId === "" || fileVersionId.length > 64) return null;
  if (address !== "bare" && address !== "version") return null;
  return { fileVersionId, address };
}

/** What a capture is told when the page it was made on no longer shows what its writer means. */
export const CAPTURE_RELOAD_MESSAGE = "This file has a newer version than the one this page is showing. Reload the page, then select the passage again.";

/**
 * The stamp a link the app writes carries (docs/PDF.md §13, "Links into the
 * file"): the number of the version its writer read, once the file has a
 * second version, and none before. **A second version is a second
 * `file_version` row**, a candidate or an abandoned one as much as a promoted
 * one, so `versionCount` is the file's rows and a file that has begun to
 * stamp its links never stops.
 */
export function pageStampFor(versionNumber: number, versionCount: number): number | "sole" {
  return versionCount > 1 ? versionNumber : "sole";
}

/**
 * A PDF's reading address as a link's path writes it: `/pdf/<slug>`, or a
 * version's own, `/pdf/<slug>/v/<n>` (and `/pdf/<slug>/v<n>`, which redirects
 * to it). `version` is null for the bare address. Null for any other path.
 *
 * **Every reader of a link into a PDF parses its path here**: the fragment
 * check, a citation's referent and the integrity script. One that takes only
 * `/pdf/<slug>` passes over a link copied from an earlier version's address
 * bar unchecked.
 */
export function parsePdfPath(pathname: string): { slug: string; version: number | null } | null {
  const match = /^\/pdf\/([^/]+)(?:\/v\/?([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (match[2] === undefined) return { slug, version: null };
  const version = parseVersionNumber(match[2]);
  return version === null ? null : { slug, version };
}
