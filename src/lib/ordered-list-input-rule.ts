import { InputRule } from "@tiptap/core";
import type { Node as PMNode, NodeType } from "@tiptap/pm/model";
import { canJoin, findWrapping } from "@tiptap/pm/transform";
import { opensList, orderedListMarker, resolveOrderedListMarker, type OrderedListStyle } from "./ordered-list-markers";

// docs/TIPTAP.md "Typing a marker starts a lettered or Roman list". The
// package's input rule turns "1. " at a paragraph's start into a numbered
// list; this one does the same for the other four styles, with the marker
// rule the Markdown parse uses (docs/DOC_IMPORT.md §12): one letter or a valid
// Roman numeral, then ")" and one space, or "." and two. One space after a
// period is how a paragraph opening "C. S. Lewis" or "I. M. Pei" begins, and
// stays text.

/** A marker typed at a paragraph's start, then ")" and a space or "." and two: `match[1]` is the marker. */
export const TYPED_ORDERED_LIST_INPUT = /^([A-Za-z]+)(?:\)\s|\.\s\s)$/;

function isTyped(type: unknown): type is "a" | "A" | "i" | "I" {
  return type === "a" || type === "A" || type === "i" || type === "I";
}

/**
 * What typing `marker` at a paragraph's start makes, given the nodes before
 * the paragraph at its level, in document order.
 *
 * The nearest of those that is a lettered or Roman list whose next item
 * `marker` is decides the style and start: so "c) " under a list a–b, with a
 * paragraph of discussion between, carries on from c, and "v) " after a list
 * i–iv is Roman 5 rather than the letter v. When that list is directly above,
 * the new item joins it. With no such list, the marker is read on its own, as
 * the Markdown parse reads a first marker (`c` letters from 3, `ii` Roman 2).
 * Null when `marker` opens nothing: two letters that aren't a numeral.
 */
export function typedOrderedListInput(
  marker: string,
  before: readonly PMNode[],
): { type: OrderedListStyle; start: number; join: boolean } | null {
  if (!opensList(marker)) return null;
  for (let index = before.length - 1; index >= 0; index--) {
    const node = before[index];
    if (node.type.name !== "orderedList" || !isTyped(node.attrs.type)) continue;
    const next = (typeof node.attrs.start === "number" ? node.attrs.start : 1) + node.childCount;
    if (orderedListMarker(node.attrs.type, next) === marker) {
      return { type: node.attrs.type, start: next, join: index === before.length - 1 };
    }
  }
  const { type, start } = resolveOrderedListMarker(marker);
  return { type, start, join: false };
}

/** The input rule for an `orderedList` node type: wraps the paragraph, and joins the list above when continuing it. */
export function typedOrderedListInputRule(listType: NodeType): InputRule {
  return new InputRule({
    find: TYPED_ORDERED_LIST_INPUT,
    handler: ({ state, range, match }) => {
      const $start = state.doc.resolve(range.from);
      const parent = $start.node(-1);
      const siblings: PMNode[] = [];
      for (let index = 0; index < $start.index(-1); index++) siblings.push(parent.child(index));
      const decision = typedOrderedListInput(match[1], siblings);
      if (!decision) return null;

      const tr = state.tr.delete(range.from, range.to);
      const blockRange = tr.doc.resolve(range.from).blockRange();
      const attrs = { type: decision.type, start: decision.join ? 1 : decision.start };
      const wrapping = blockRange && findWrapping(blockRange, listType, attrs);
      if (!wrapping) return null;
      tr.wrap(blockRange, wrapping);

      const before = tr.doc.resolve(range.from - 1).nodeBefore;
      if (decision.join && before?.type === listType && canJoin(tr.doc, range.from - 1)) tr.join(range.from - 1);
    },
  });
}
