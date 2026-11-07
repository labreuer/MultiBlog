import type { JSONContent } from "@tiptap/core";
import { chipLabels, isChip, type ChipLabels } from "./text";
import type { ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 8 — a doc's `prose_json` holds each
// chip's label beside its identity, as of the write. The ydoc never holds a
// label (rule 1); the cache does because its readers are static ones with no
// chip context to compute from: the `prose_text` SQL function behind
// full-text search and its snippets, `extractMarkedText`, an export.
//
// The label is one more attribute on the JSON node, `label`. The node's
// schema doesn't declare it, so decoding the JSON drops it and positions are
// untouched: `prose_json` still seeds the rail (CLAUDE.md), and a chip's
// place in it is the ydoc's.
//
// What it costs is that the cache no longer equals what the ydoc decodes to:
// it is that, plus labels. `withoutChipLabels` is the way back, for anything
// that compares the two.
//
// Browser-safe and pure. `materializeChipLabels` (context.ts) is the
// server's: it loads the context these are relabelled from.

/** `doc` with each chip's label written onto its node. Chips with no entry in `labels` are left as they are. */
export function withChipLabels(doc: JSONContent, labels: ChipLabels): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    if (isChip(node)) {
      const label = typeof node.attrs?.iid === "string" ? labels.get(node.attrs.iid) : undefined;
      return label === undefined ? node : { ...node, attrs: { ...node.attrs, label } };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return walk(doc);
}

/** `doc` with no chip carrying a label: what its ydoc decodes to. */
export function withoutChipLabels(doc: JSONContent): JSONContent {
  const walk = (node: JSONContent): JSONContent => {
    if (isChip(node)) {
      if (!node.attrs || !("label" in node.attrs)) return node;
      const attrs = { ...node.attrs };
      delete attrs.label;
      return { ...node, attrs };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return walk(doc);
}

/** `doc` relabelled from `inputs`: every chip's label is the one these inputs give, stale ones replaced. */
export function relabelChips(doc: JSONContent, inputs: ChipInputs): JSONContent {
  return withChipLabels(withoutChipLabels(doc), chipLabels(doc, inputs));
}
