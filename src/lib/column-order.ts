// Shared shape between `User.columnOrder` and `SiteSettings.defaultColumnOrder`
// (PLAN.md §16i) — both are a Json object keyed by table, each value an
// ordered list of visible column keys. Same parsing either way, which is the
// point of factoring it out here rather than leaving two copies to drift:
// membership is visibility, position is order, and a value that isn't a
// non-empty array of strings degrades to "no opinion" (`null`) rather than
// being partially honoured — a half-valid column list would hide real
// columns, with nothing on screen explaining that a stored value is why.

// The admin tables that carry these preferences. A string union rather than a
// free-form key, so a typo in a page is a type error instead of a silently
// ignored preference.
export type AdminTableName = "posts" | "docs" | "files" | "users" | "comments" | "annotations" | "keywords";

export function columnOrderFor(stored: unknown, table: AdminTableName): string[] | null {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
  const forTable = (stored as Record<string, unknown>)[table];
  if (!Array.isArray(forTable)) return null;
  const keys = forTable.filter((key): key is string => typeof key === "string");
  return keys.length > 0 ? keys : null;
}
