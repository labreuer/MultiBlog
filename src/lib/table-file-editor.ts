// PLAN.md §24c — the two editor-facing operations over the format table:
// a file becomes a table node in a live editor, and a table node in one
// becomes a file. Shared by TableControls' menu (insert at the caret,
// download the table around it), CollabEditorBody's drop handler (insert
// at the drop point) and the reading views' per-table download button.
// Browser-only — it takes an Editor.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { gridToTableJson, tableJsonToGrid } from "./table-grid";
import { readTableFile, type TableCodec } from "./table-codecs";
import { downloadBlob } from "./download-blob";

// A cell is `block+` and a table is a block, so the schema would nest a
// table inside a cell without complaint. Nothing wants that (the toolbar's
// insert button is disabled inside a table for the same reason), so both
// insert paths refuse rather than nest.
function insideTable(editor: Editor, pos: number): boolean {
  const $pos = editor.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "table") return true;
  }
  return false;
}

/**
 * Reads the file, builds the node, inserts it — at `at` (a drop point) or
 * at the caret. Resolves to null on success, or to the message to show.
 */
export async function insertTableFromFile(editor: Editor, file: File, at?: number): Promise<string | null> {
  const read = await readTableFile(file);
  if (!read.ok) return read.error;
  let json;
  try {
    json = gridToTableJson(read.grid);
  } catch (err) {
    return `Couldn't build a table from ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const pos = at ?? editor.state.selection.from;
  if (insideTable(editor, pos)) {
    return at === undefined
      ? "The caret is inside a table — a table can't hold another. Move it out first."
      : "Dropped inside a table — a table can't hold another. Drop it on the text around it.";
  }
  if (at === undefined) editor.chain().focus().insertContent(json).run();
  else editor.chain().focus().insertContentAt(at, json).run();
  return null;
}

/** A table node written through `codec` and handed to the browser. */
export async function downloadTableNode(node: PMNode, codec: TableCodec, filename: string): Promise<void> {
  const grid = tableJsonToGrid(node.toJSON());
  downloadBlob(await codec.write(grid), filename);
}
