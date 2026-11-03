import type { ResolvedPos } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

// docs/TIPTAP.md "A numbered list's style is its `type`". TipTap's orderedList
// carries the HTML `type` attribute — "1", "a", "A", "i", "I" — and renders it
// on the <ol>, where the browser draws the markers from it. The stock package
// parses it from pasted HTML but offers no command to set it, and its
// generic `updateAttributes` would restyle *every* orderedList around a
// caret, the outer one of a nested pair included. These act on the innermost
// one only: the list whose markers the caret's item actually shows.

/** The numbering styles, in menu order. `null` is the default, plain numbers, stored as no `type` at all. */
export const ORDERED_LIST_STYLES = [
  { type: null, label: "Numbers (1, 2, 3)" },
  { type: "a", label: "Lowercase letters (a, b, c)" },
  { type: "A", label: "Uppercase letters (A, B, C)" },
  { type: "i", label: "Lowercase Roman (i, ii, iii)" },
  { type: "I", label: "Uppercase Roman (I, II, III)" },
] as const;

export type OrderedListType = (typeof ORDERED_LIST_STYLES)[number]["type"];

/** The innermost orderedList holding `$pos`, with its position, or null outside every one. */
export function orderedListAround($pos: ResolvedPos): { pos: number; type: OrderedListType } | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "orderedList") {
      // "1" is what pasted HTML can say for the default; it reads as plain numbers.
      const type = node.attrs.type === "1" ? null : (node.attrs.type as OrderedListType);
      return { pos: $pos.before(depth), type };
    }
  }
  return null;
}

/** The style of the list the selection starts in, or undefined when it starts in no numbered list. */
export function currentOrderedListType(state: EditorState): OrderedListType | undefined {
  const found = orderedListAround(state.selection.$from);
  return found ? found.type : undefined;
}

/**
 * Sets the numbering style of the list the selection starts in, on `tr`.
 * Returns false and leaves `tr` untouched when there is no such list.
 */
export function setOrderedListType(tr: Transaction, type: OrderedListType): boolean {
  const found = orderedListAround(tr.selection.$from);
  if (!found) return false;
  const node = tr.doc.nodeAt(found.pos);
  if (!node) return false;
  tr.setNodeMarkup(found.pos, undefined, { ...node.attrs, type });
  return true;
}
