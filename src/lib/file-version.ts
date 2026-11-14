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
