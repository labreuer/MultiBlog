import * as Y from "yjs";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { Node as PMNode } from "@tiptap/pm/model";
import { alignBlocks } from "./block-align";
import { blockText } from "./doc-text";
import { blockKey } from "./doc-edit";

// docs/MCP.md §6, step 3 — an edited doc written back into its ydoc block by
// block, never as a whole fragment:
//
//   - a block that didn't change is left alone;
//   - a paired block that changed is written with
//     `prosemirrorToYXmlFragment(newBlock, yBlock)`, which y-prosemirror
//     accepts for a single element: within a textblock it rewrites the span
//     from its first changed character to its last, with the marks the merge
//     kept on the words in it. A container recurses, so y-prosemirror is only
//     ever handed one textblock;
//   - a block left over is inserted or deleted whole.
//
// **Writing the whole fragment back is rejected**, because y-prosemirror then
// pairs the fragment's blocks itself, greedily and in order: it mis-pairs when
// an edit adds or removes a block between two changed ones, writing one
// block's Yjs items into its neighbour, and a block carrying overlapping
// annotations never compares equal (each annotation is a mark of its own, and
// its comparison checks only the first of a name), so an insertion ahead of
// one would rewrite every block in between. The marks would survive; Yjs item
// identity and the span-only update would not, and someone typing in a
// rewritten block would find their characters among tombstones elsewhere.

function childrenOf(node: PMNode): PMNode[] {
  const children: PMNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

function insertNode(parent: Y.XmlFragment | Y.XmlElement, index: number, node: PMNode): void {
  const element = new Y.XmlElement(node.type.name);
  parent.insert(index, [element]);
  prosemirrorToYXmlFragment(node, element as unknown as Y.XmlFragment);
}

function syncAttributes(element: Y.XmlElement, node: PMNode): void {
  const current = element.getAttributes();
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined) {
      if (key in current) element.removeAttribute(key);
    } else if (current[key] !== value) {
      element.setAttribute(key, value as string);
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in node.attrs)) element.removeAttribute(key);
  }
}

function syncNode(parent: Y.XmlFragment | Y.XmlElement, index: number, old: PMNode, next: PMNode): void {
  const element = parent.get(index);
  if (!(element instanceof Y.XmlElement) || element.nodeName !== next.type.name) {
    parent.delete(index, 1);
    insertNode(parent, index, next);
    return;
  }
  if (next.isTextblock || next.isLeaf) {
    prosemirrorToYXmlFragment(next, element as unknown as Y.XmlFragment);
    return;
  }
  syncAttributes(element, next);
  syncChildren(element, childrenOf(old), childrenOf(next));
}

/** `parent`'s children, which are `old`, rewritten to be `next` with the fewest changes the alignment allows. */
function syncChildren(parent: Y.XmlFragment | Y.XmlElement, old: PMNode[], next: PMNode[]): void {
  const pairs = alignBlocks(old.map(blockText), next.map(blockText), { old: old.map(blockKey), new: next.map(blockKey) });
  let index = 0;
  for (const pair of pairs) {
    if (pair.old !== null && pair.new !== null) {
      if (!old[pair.old].eq(next[pair.new])) syncNode(parent, index, old[pair.old], next[pair.new]);
      index++;
    } else if (pair.old !== null) {
      parent.delete(index, 1);
    } else {
      insertNode(parent, index, next[pair.new!]);
      index++;
    }
  }
}

/**
 * Writes `next` into `fragment`, which holds `old` — the doc the edit was
 * planned against, decoded from this same fragment. The caller runs it inside
 * one transaction.
 */
export function writeBackDoc(fragment: Y.XmlFragment, old: PMNode, next: PMNode): void {
  syncChildren(fragment, childrenOf(old), childrenOf(next));
}
