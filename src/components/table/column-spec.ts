import type { MouseEventHandler, ReactNode, RefObject } from "react";

// A table's columns as data (PLAN.md §16i), so visibility and order can be a
// querystring param instead of five hand-edited `<thead>`s.
//
// This is deliberately not the `<DataTable columns={…} />` §16a rules out. The
// kit decides *which* columns render and in *what order*; it never decides what
// a cell looks like. `cell` returns whatever JSX the table wants and is written
// inside the table component, so a cell is still an ordinary React expression
// closing over that component's hooks, state and server actions — which is what
// keeps `UsersTable`'s inline-edit cells and `PostsTable`'s countdown tooltip
// possible at all.
export type ColumnSpec<Row> = {
  /**
   * Stable identifier, never the array index — a saved order has to survive a
   * column being added or removed, which means naming columns, not positions.
   * This is also what appears in `?cols=`, so it is a user-visible string:
   * keep it short and lowercase.
   */
  key: string;
  header: ReactNode;
  /**
   * The `?sort=` key, when this column sorts. Absent means the header renders
   * as a plain `<th>` — an avatar or an action button is not a sort key.
   */
  sortKey?: string;
  /** `nowrapCell`/`nowrapHeaderCell` instead of the default cell classes. */
  nowrap?: boolean;
  /** Extra class on the `<th>` — `/users`' Name column widens itself this way. */
  headerClassName?: string;
  /** `title` on the `<th>` — a tooltip for what the column means, not what a row's status is. */
  headerTitle?: string;
  /**
   * Cannot be hidden or reordered, and never appears in `?cols=`. For the
   * selection checkbox and the delete/restore control: hiding the only way to
   * act on a row is not a customization, it is a broken table.
   */
  alwaysVisible?: boolean;
  /**
   * Movable but excluded from the default view — still listed in the picker,
   * unchecked, so it can be turned on. For a column carrying real data (every
   * genuine Postgres column ought to be *available*, PLAN.md §16l) that most
   * admins won't want cluttering the table every time: `/comments`' IP
   * address, `/posts`' raw `moderation_policy` (the resolved policy already
   * shows through other columns), audit timestamps like `deleted_at`. Ignored
   * if `alwaysVisible` is also set — a column can't be both permanently shown
   * and hidden by default.
   */
  defaultHidden?: boolean;
  cell: (row: Row) => ReactNode;
  /**
   * Props for the `<td>` itself, for the handful of cells that need more than
   * content — `/docs`' Title cell makes the whole cell a click target, not just
   * the link inside it. Kept to the two properties actually used rather than
   * spreading arbitrary attributes, so the kit still owns the cell's identity.
   */
  cellProps?: (row: Row) => { className?: string; onClick?: MouseEventHandler<HTMLTableCellElement> };
  /**
   * A complete replacement `<th>`, for a header that isn't "label plus sort
   * arrows" — the deleted column's icon button. Mutually exclusive with
   * `header`/`sortKey`, which are what the default header is built from.
   */
  renderHeader?: () => ReactNode;
  /** Measured by `/posts` to size its search box to the Title column. */
  thRef?: RefObject<HTMLTableCellElement | null>;
};

/**
 * The columns `resolveColumns` shows when there is no `?cols=` and no stored
 * preference at any level: every column except the ones that opted out with
 * `defaultHidden`. `alwaysVisible` columns are excluded here too — they're
 * handled by their own re-insertion step below, not by riding along in this
 * list.
 *
 * This is the *last* fallback, not the only one. `cols` itself already
 * carries a user's saved order or, failing that, the site's configured
 * default (`getTablePrefs` resolves that precedence server-side, before this
 * function ever runs) — `defaultColumnKeys` only fires when neither a user
 * nor a site admin has ever expressed an opinion about this table.
 */
function defaultColumnKeys<Row>(columns: ColumnSpec<Row>[]): string[] {
  return columns.filter((column) => !column.alwaysVisible && !column.defaultHidden).map((column) => column.key);
}

/**
 * Resolves declared columns against a `?cols=` list (or a stored preference —
 * they are the same shape, see TablePrefs).
 *
 * `cols === null` means no opinion at any level — see `defaultColumnKeys` —
 * computed and then fed through the same resolution `cols` itself would get,
 * so "no opinion" isn't a separate code path that could drift from what an
 * explicit `?cols=` produces.
 *
 * Otherwise `cols` names the movable columns to show, in order. Unknown keys
 * are dropped here rather than in table-query.ts, because this is the only
 * layer that knows which keys exist — a hand-edited URL naming a column that
 * was renamed should degrade to "not shown", not to a crash.
 *
 * **A movable column absent from `cols` is hidden**, including one added to the
 * code *after* a user saved their preference. That follows from the single
 * ordered list §16i chose — membership is visibility — and it is the cost of
 * that choice: a newly shipped column is invisible to anyone with a saved
 * preference for that table until they re-open the picker. `defaultHidden` is
 * the same mechanism pointed the other way: a column that is *never* meant to
 * clutter the default view (an audit timestamp, a raw IP) without every admin
 * having to say so individually. The alternative (a second "hidden" param, so
 * absent could mean "new") is the two-param design §16i rejected.
 *
 * `alwaysVisible` columns ignore `cols` entirely and are re-inserted at their
 * declared index, so the selection checkbox stays leftmost and the row action
 * stays rightmost however the middle is rearranged.
 */
export function resolveColumns<Row>(columns: ColumnSpec<Row>[], cols: string[] | null): ColumnSpec<Row>[] {
  const effectiveCols = cols ?? defaultColumnKeys(columns);

  const movable = columns.filter((column) => !column.alwaysVisible);
  const byKey = new Map(movable.map((column) => [column.key, column]));

  const chosen: ColumnSpec<Row>[] = [];
  const seen = new Set<string>();
  for (const key of effectiveCols) {
    const column = byKey.get(key);
    if (!column || seen.has(key)) continue; // unknown, fixed, or repeated
    seen.add(key);
    chosen.push(column);
  }

  // Re-insert the fixed columns at the positions they were declared at. Done
  // ascending so each insertion lands after the ones before it have already
  // shifted the list, and clamped because the movable list is usually shorter
  // than the declared one.
  const resolved = chosen;
  columns.forEach((column, declaredIndex) => {
    if (!column.alwaysVisible) return;
    resolved.splice(Math.min(declaredIndex, resolved.length), 0, column);
  });
  return resolved;
}

/** The movable columns, in the order the picker should list them. */
export function pickerColumns<Row>(columns: ColumnSpec<Row>[], resolved: ColumnSpec<Row>[]): ColumnSpec<Row>[] {
  const movableResolved = resolved.filter((column) => !column.alwaysVisible);
  const shown = new Set(movableResolved.map((column) => column.key));
  // Visible ones first in their current order, then the hidden ones in
  // declaration order — so dragging reorders what you see, and the rest sit
  // below waiting to be checked.
  return [...movableResolved, ...columns.filter((column) => !column.alwaysVisible && !shown.has(column.key))];
}
