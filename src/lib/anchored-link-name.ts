// docs/ANCHORED_LINKS.md, "Naming a link" — an anchored link's optional name,
// the doc-title.ts of this feature: pure, no Prisma, so the server pages, the
// tray and the /links cell all read and normalise through one pair of
// functions. "Linked passages" is never stored: it is supplied here, at
// render, everywhere an unnamed link needs a title.

export const UNNAMED_LINK_TITLE = "Linked passages";

/** The tag-name cap (src/app/actions/tags.ts): a name is a handle, not a description. */
export const LINK_NAME_MAX_LENGTH = 80;

/**
 * What the writer stores for a name as typed: trimmed, internal whitespace
 * collapsed, capped — and **null for nothing**, never an empty string
 * (`anchored_link_name_not_blank_check` refuses a blank at the database, so
 * a reader's `?? UNNAMED_LINK_TITLE` is the whole fallback).
 */
export function normalizeLinkName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ").slice(0, LINK_NAME_MAX_LENGTH).trim();
  return name === "" ? null : name;
}

/** The title a link shows — its name, or the generic one for an unnamed link. */
export function anchoredLinkTitle(name: string | null | undefined): string {
  return name ?? UNNAMED_LINK_TITLE;
}
