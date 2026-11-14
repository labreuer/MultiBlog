/**
 * The rows of a Prisma read whose required relations all arrived.
 *
 * Prisma loads each relation an `include` or a `select` names in a statement
 * of its own, after the rows' statement and with no snapshot shared between
 * them (docs/DATABASE.md, "A relation is loaded in a statement of its own").
 * A parent row hard-deleted between the two comes back null, with no error,
 * in a field whose generated type has no null: the caller's first read of it
 * throws, and a page answers 500. The row itself is gone by then, by the same
 * cascade, or its foreign key would have refused the delete. Leaving it out is
 * the listing as it now is.
 *
 * `parents` answers the relations the caller goes on to read: a nested one
 * through `?.`, since its own parent may be the one missing, and an optional
 * one only where its foreign key says there is a row to load.
 */
export function rowsWithParents<Row>(rows: readonly Row[], parents: (row: Row) => readonly unknown[]): Row[] {
  return rows.filter((row) => parents(row).every((parent) => parent !== null && parent !== undefined));
}
