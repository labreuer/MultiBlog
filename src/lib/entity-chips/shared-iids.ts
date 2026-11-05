import * as Y from "yjs";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { chipsIn } from "./renderings";
import { ENTITY_CHIP } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 3 — two chips sharing an instance id
// that no single client made.
//
// A client that pastes a copy gives the copy a fresh id at once
// (`repairChipIids`, node.ts). What it can't see is a duplicate made by two
// clients at the same time: one cuts a chip and pastes it elsewhere, which
// keeps its id, while another undoes an earlier deletion of that chip, which
// restores it. Each change is fine alone; merged, the doc holds one id twice,
// and every resolver that goes by instance (anchors/chips.ts) refuses to
// pick either.
//
// Every client that receives such a state repairs it, and they must all
// write the same thing, or their repairs would themselves be concurrent
// edits that disagree. So the later chip in doc order gets an id **derived
// from its Yjs item** (the client and clock that created it), which every
// replica sees alike. A random id here would leave as many values as there
// are open tabs, the last writer's standing.

/** A Yjs item's identity as an instance id. The dot keeps it apart from a random id, which has none. */
export function iidFromItem(id: { client: number; clock: number }): string {
  return `y${id.client.toString(36)}.${id.clock.toString(36)}`;
}

/** The Yjs item of every chip under `type`, in document order. */
export function chipItemIds(type: Y.XmlFragment | Y.XmlElement): { client: number; clock: number }[] {
  const ids: { client: number; clock: number }[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === ENTITY_CHIP) {
        const item = child._item;
        if (item) ids.push({ client: item.id.client, clock: item.id.clock });
      } else {
        walk(child);
      }
    }
  };
  walk(type);
  return ids;
}

/**
 * For chips in doc order and their Yjs items in the same order: the new id
 * of each chip that shares an id with an earlier one. Empty ids are left to
 * the client that inserted them.
 */
export function sharedIidFixes(
  chips: readonly { pos: number; iid: string }[],
  items: readonly { client: number; clock: number }[],
): { pos: number; iid: string }[] {
  const seen = new Set<string>();
  const fixes: { pos: number; iid: string }[] = [];
  chips.forEach((chip, index) => {
    if (chip.iid === "") return;
    if (seen.has(chip.iid)) fixes.push({ pos: chip.pos, iid: iidFromItem(items[index]) });
    else seen.add(chip.iid);
  });
  return fixes;
}

/**
 * The repair, as the transaction to append, or null. Only right after a
 * remote change with nothing local beside it, when this document and the
 * Yjs one hold the same chips in the same order; an editor with no Yjs
 * binding (a reading view) repairs nothing, having nowhere to write.
 */
export function repairSharedIids(transactions: readonly Transaction[], newState: EditorState): Transaction | null {
  const changed = transactions.filter((tr) => tr.docChanged);
  if (changed.length === 0 || !changed.every((tr) => isChangeOrigin(tr))) return null;

  const chips = chipsIn(newState.doc);
  if (new Set(chips.map((chip) => chip.iid)).size === chips.length) return null;

  const sync = ySyncPluginKey.getState(newState) as { type?: Y.XmlFragment; binding?: unknown } | undefined;
  if (!sync?.binding || !sync.type) return null;
  const items = chipItemIds(sync.type);
  if (items.length !== chips.length) return null;

  const fixes = sharedIidFixes(chips, items);
  if (fixes.length === 0) return null;
  const tr = newState.tr;
  for (const fix of fixes) tr.setNodeAttribute(fix.pos, "iid", fix.iid);
  // Not the user's edit: an undo must not put the shared id back.
  return tr.setMeta("addToHistory", false);
}
