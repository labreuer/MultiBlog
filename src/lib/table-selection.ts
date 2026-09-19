// The table node the selection is in, if any, with its position — what
// every menu item that acts on "this table" (download, auto-size) starts
// from. The walk is by node type name rather than `isActive("table")`
// because the callers need the node, not a boolean.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export function tableAroundSelection(editor: Editor): { node: PMNode; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "table") return { node, pos: $from.before(depth) };
  }
  return null;
}
