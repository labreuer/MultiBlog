// PLAN.md §22b — the three-minute window, and the two predicates every
// reader-facing decision about an edit is made with.
//
// **This is a display rule, not a storage rule.** Every version of every
// comment and annotation body is stored (`comment_revision`; a
// `ydoc_snapshot` per settled state on an annotation body's own ydoc); what
// this file decides is which of them a *reader* is ever told about. Nothing
// here filters what a moderator sees — /comments' and /annotations' Edited
// columns read `editedAt`, which is stamped on every edit, silent or not.
//
// One constant and one pair of functions, for both kinds. A comment and an
// annotation differ in what a version *is* (a row of text vs. a settled ydoc
// state) and not at all in when an edit becomes visible, so a second copy of
// this rule for the annotation side would be a second place for it to drift.
// Pure, synchronous, no Prisma — the callers hand it rows they have already
// loaded, and `src/lib/edit-grace.test.ts` is the table of cases.

/**
 * How long after *posting* an edit stays invisible to readers.
 *
 * Measured from posting rather than from the previous edit, deliberately
 * (§22b): from the last edit, a chain of edits three minutes apart would stay
 * silent forever, and the window exists to cover fixing a typo you notice
 * immediately after posting — a property of having just posted.
 *
 * A constant rather than a `site_settings` column because nobody has asked
 * for a second value; growing one later changes this file and nothing else.
 */
export const EDIT_GRACE_MS = 3 * 60 * 1000;

/**
 * How long an abandoned annotation edit session (PLAN.md §22e) is left alone
 * before the card offers Resume or Discard instead of "someone is editing
 * this".
 *
 * An hour rather than minutes because the cost of being wrong is asymmetric:
 * too short and a long, deliberate edit is offered a Discard button by its own
 * author mid-sentence; too long and the body's cache stays frozen at its last
 * settled state, which is what readers are supposed to be seeing anyway.
 * Nothing is lost by waiting — the ydoc holds every keystroke either way.
 *
 * Here rather than beside the actions that use it because the loader needs it
 * too — annotation-data.ts is what decides, against the server's clock,
 * whether a session counts as abandoned — and every export of a `"use server"`
 * module has to be an async function.
 */
export const STALE_EDIT_SESSION_MS = 60 * 60 * 1000;

/**
 * One version, reduced to the three facts the rule needs.
 *
 * `supersededAt` is null for exactly one version — the current one — and is
 * the *next* version's creation time for every other. It is derived rather
 * than stored: a column holding it would be a second place for the same fact
 * to be wrong.
 *
 * `quoted` is whether anything points at this specific version: a comment
 * quotation's revision pin (§23c) on one side, an anchored reply's version
 * stamp falling in the version's span (`isVersionQuoted`) on the other. A
 * parameter rather than a lookup so that the rule below is complete as
 * written, and pure.
 */
export type GraceVersion = {
  createdAt: Date;
  supersededAt: Date | null;
  quoted: boolean;
};

/**
 * Whether readers are never told this version existed.
 *
 * Three ways to fail to be silent, and each is the whole point of one clause:
 * being the current version (there is nothing to hide — this is the text on
 * screen), being replaced after the window closed, or being quoted. A quote
 * closes the window early because a reply to "the sky is green" reads as a
 * non-sequitur the moment those words silently become "the sky is blue", with
 * no explanation available to anyone; making the quoted version visible is
 * what leaves the reader something to find.
 */
export function isSilentVersion(version: GraceVersion, postedAt: Date): boolean {
  if (version.supersededAt === null) return false;
  if (version.quoted) return false;
  return version.supersededAt.getTime() <= postedAt.getTime() + EDIT_GRACE_MS;
}

/**
 * The versions a reader may see, oldest-first, given every version
 * oldest-first.
 *
 * A silent version is *collapsed into the one that superseded it* rather than
 * dropped from a numbered sequence: a comment posted at 0:00, edited at 0:01
 * and edited again at 0:10 shows the 0:01 text as its original, because that
 * is the text as it stood when the window closed. That is what silence means
 * here — the reader's record starts from when they could first have been
 * relying on it.
 *
 * `postedAt` is the moment readers could first have seen anything: the first
 * version's `createdAt`, which for an annotation is its DRAFT → LIVE
 * transition and not the row's creation (a DRAFT is visible to nobody but its
 * author). Taken as an argument rather than read off `versions[0]` so a caller
 * that knows better — a backfilled row, a container whose posting time lives
 * elsewhere — can say so.
 */
export function visibleVersions<T extends GraceVersion>(versions: T[], postedAt: Date): T[] {
  return versions.filter((version) => !isSilentVersion(version, postedAt));
}

/**
 * Whether to show an "edited" marker at all.
 *
 * Equivalent to "more than one visible version", and stated as its own
 * function because that equivalence is an implementation detail of the
 * collapse rule above rather than something a call site should know.
 */
export function isVisiblyEdited<T extends GraceVersion>(versions: T[], postedAt: Date): boolean {
  return visibleVersions(versions, postedAt).length > 1;
}

/**
 * Turns rows ordered oldest-first into `GraceVersion`s by pairing each with
 * its successor's timestamp.
 *
 * The one place the derivation of `supersededAt` lives, so that the comment
 * and annotation loaders cannot disagree about it. `quoted` is asked per row
 * by the caller, which is the half that genuinely differs between them: a
 * comment's quote is a foreign key to a revision (§23c), an annotation's is a
 * reply's version stamp falling inside a version's span (`isVersionQuoted`).
 */
export function withSupersededAt<T extends { createdAt: Date }>(
  rows: T[],
  isQuoted: (row: T, index: number) => boolean,
): (T & GraceVersion)[] {
  return rows.map((row, index) => ({
    ...row,
    supersededAt: index + 1 < rows.length ? rows[index + 1].createdAt : null,
    quoted: isQuoted(row, index),
  }));
}

/**
 * Whether the version at `index` — of a body's versions in mark order — is
 * one an anchored reply was reading when it quoted the body (PLAN.md §22e).
 *
 * A reply's stamp is the mark of its parent's newest version at the time,
 * and a version at mark `m[i]` was what readers saw for every log position in
 * `(m[i-1], m[i]]` — the first version for everything up to and including its
 * own mark. So a stamp names the version whose span it falls in, and a
 * version somebody quoted is one the window may not silence: a reply to "the
 * sky is green" must be able to find those words after they become "the sky
 * is blue".
 *
 * Marks strictly increase with index (`check-annotation-snapshots.ts`'s
 * `monotone`). Pure, so the loaders that already hold a page's replies and
 * the history action that fetches one body's can apply one rule.
 */
export function isVersionQuoted(marks: bigint[], stamps: bigint[], index: number): boolean {
  const upper = marks[index];
  if (upper === undefined) return false;
  const lower = index > 0 ? marks[index - 1] : null;
  return stamps.some((stamp) => stamp <= upper && (lower === null || stamp > lower));
}
