"use client";

import { PAGE_SIZE_OPTIONS, type PageSize } from "@/lib/table-query";
import styles from "./AdminTable.module.css";

// The "filtering & the URL" panel every admin table carries (PLAN.md §16d).
//
// The four shared rows are generated from the same values the parser uses —
// PAGE_SIZE_OPTIONS and the table's own sort-key list — rather than restated
// in prose. CommentsTable's hand-written version had already drifted into
// naming a fixed page-size list and its own sort keys twice; a table can only
// get those wrong here by passing the wrong spec.

export type FilterHelpEntry = {
  param: string;
  meaning: React.ReactNode;
  control: string;
};

const DEEP_LINK_CONTROL = "Deep link only — edit the URL";

export function deepLinkEntry(param: string, meaning: React.ReactNode): FilterHelpEntry {
  return { param, meaning, control: DEEP_LINK_CONTROL };
}

export function FilterHelp({
  sortKeys,
  defaultPageSize,
  searchDescription,
  filters = [],
  deepLinks = [],
  notes,
}: {
  sortKeys: readonly string[];
  defaultPageSize: PageSize;
  searchDescription: React.ReactNode;
  // Table-specific filters with their own controls (the multi-select
  // dropdowns), rendered above the shared four.
  filters?: FilterHelpEntry[];
  deepLinks?: FilterHelpEntry[];
  notes?: React.ReactNode;
}) {
  const shared: FilterHelpEntry[] = [
    {
      param: "deleted",
      meaning: (
        <>
          <code>1</code> to include soft-deleted rows; omitted hides them.
        </>
      ),
      control: "Show deleted rows checkbox",
    },
    { param: "q", meaning: searchDescription, control: "Search box" },
    {
      param: "page / pageSize",
      meaning: (
        <>
          1-indexed page number, and rows per page ({PAGE_SIZE_OPTIONS.join(", ")}). Omitting{" "}
          <code>pageSize</code> uses your own default, currently {defaultPageSize} — set per account
          in <code>/users</code>, so this param is a temporary override rather than a preference.
        </>
      ),
      control: "Prev/Next and rows-per-page dropdown",
    },
    {
      param: "sort",
      meaning: (
        <>
          Comma-separated <code>key:asc</code>/<code>key:desc</code> pairs; ctrl-click a column to add it as a
          secondary sort key. Sortable keys: {sortKeys.join(", ")}.
        </>
      ),
      control: "Click a column header",
    },
  ];

  const rows = [...filters, ...shared, ...deepLinks];

  return (
    <details className={styles.helpPanel}>
      <summary className={styles.helpSummary}>Help: filtering &amp; the URL</summary>
      <div className={styles.helpBody}>
        <p>The controls on this page are mirrored into the querystring, so a filtered view can be bookmarked or shared.</p>
        <table className={styles.helpTable}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th className={styles.helpHeaderCell}>Param</th>
              <th className={styles.helpHeaderCell}>Meaning</th>
              <th className={styles.helpHeaderCell}>Control</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.param}>
                <td className={styles.helpCell}>
                  <code>{row.param}</code>
                </td>
                <td className={styles.helpCell}>{row.meaning}</td>
                <td className={styles.helpCell}>{row.control}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {notes}
      </div>
    </details>
  );
}
