// docs/TABLES.md, "Auto-size columns" — "Auto-size": strip every manual size from the table at
// the caret so it lays out like one built in the editor (equal columns,
// `table-layout: fixed; width: 100%` from prose.module.css).
//
// The only stored sizing is the cells' `colwidth` attr. Nothing else on a
// table node or its cells carries a size: Table declares no attributes at
// all, and a cell's others are colspan, rowspan and align (docs/TIPTAP.md,
// "A pasted table keeps its source's column widths"). The table's inline
// `style="width: Npx"` is *derived* from the colwidths by `createColGroup`
// at render time, on both surfaces, so nulling the attrs removes it too —
// there is no second thing to clear. A pasted table is the case that
// needs this: Word, Docs, Excel and Sheets all put a <colgroup> on the
// clipboard, and with `resizable` off there is no handle to undo it with.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { tableAroundSelection } from "./table-selection";

function isCell(node: PMNode): boolean {
  return node.type.name === "tableCell" || node.type.name === "tableHeader";
}

/** Whether any cell of the table carries a width. */
export function tableHasManualSizing(table: PMNode): boolean {
  let found = false;
  table.descendants((node) => {
    if (found) return false;
    if (isCell(node) && Array.isArray(node.attrs.colwidth) && node.attrs.colwidth.length > 0) found = true;
    // Cells hold blocks, and a nested table is legal, but its widths are
    // its own — don't descend past a cell.
    return !isCell(node);
  });
  return found;
}

/** The table at the caret with every cell's colwidth cleared. One transaction. */
export function autoSizeTable(editor: Editor): boolean {
  const found = tableAroundSelection(editor);
  if (!found || !tableHasManualSizing(found.node)) return false;
  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      // Positions are collected first and applied unchanged: setNodeMarkup
      // replaces attrs in place, so no position shifts.
      const cells: { pos: number; node: PMNode }[] = [];
      found.node.descendants((node, offset) => {
        if (isCell(node)) {
          if (node.attrs.colwidth) cells.push({ pos: found.pos + 1 + offset, node });
          return false;
        }
        return true;
      });
      for (const { pos, node } of cells) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, colwidth: null });
      }
      return true;
    })
    .run();
}
