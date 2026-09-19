// The table node view the live editors use, in place of the extension's
// stock `TableView`, to fix one thing in it (3.29.0): `updateColumns`
// reuses each `<col>` across updates and, when a column goes from having a
// width to having none, sets `min-width` on it without removing the
// `width` it set before. The table's own inline width is cleared correctly,
// so the table snaps back to `width: 100%` — but the columns keep their
// old ratio until a reload, and on every client, since the remote update
// runs through the same `update()`. "Auto-size columns" (docs/TABLES.md)
// is exactly that transition, and looked like it had done nothing.
//
// The subclass recomputes which columns have a width from the node (the
// same walk `createColGroup` does — first row, colspan by colspan) and
// removes the stale `width` from the rest, after the stock update has
// set everything else. Configured through `Table.configure({ View })`
// (tiptap-schema.ts), so the extension's own `addNodeView` still
// constructs it; only live editors ever build one, and the static
// renderer never sees this file's class at all.

import { TableView } from "@tiptap/extension-table";
import type { Node as PMNode } from "@tiptap/pm/model";

function stripStaleColumnWidths(node: PMNode, colgroup: HTMLTableColElement): void {
  const row = node.firstChild;
  if (!row) return;
  const cols = Array.from(colgroup.children) as HTMLElement[];
  for (let i = 0, col = 0; i < row.childCount; i += 1) {
    const { colspan, colwidth } = row.child(i).attrs as { colspan: number; colwidth: number[] | null };
    for (let j = 0; j < colspan; j += 1, col += 1) {
      if (!(colwidth && colwidth[j])) cols[col]?.style.removeProperty("width");
    }
  }
}

export class TableViewWithClearedWidths extends TableView {
  update(node: PMNode): boolean {
    const updated = super.update(node);
    if (updated) stripStaleColumnWidths(node, this.colgroup);
    return updated;
  }
}
