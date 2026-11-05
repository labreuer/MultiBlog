import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { chipRenderings, chipsIn, chipsInJSON } from "./renderings";
import { CHIP_ANCHOR_TEXT, ENTITY_CHIP, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 7 — the one rule for a chip's text. A
// chip has two texts, and every flattener asks here for whichever it means:
//
//  - **anchor** text, U+FFFC: what a stored quote holds where a chip is. It
//    never changes, so a rename can't detach an anchor. `textBetween` gives it
//    by itself, through the node's `leafText`; a flattener that passes its own
//    leaf argument to `textBetween` overrides that, and uses `anchorLeafText`.
//  - **display** text, the label: what anything that shows or searches text
//    uses. A label is computed, never stored in a ydoc, so a flattener gets it
//    from `ChipLabels` (computed from a chip context), or from the `label`
//    a cache write put on the JSON node (`prose_json`), in that order.
//
// A flattener that handles neither shows nothing where a chip is, with no
// error. text.test.ts runs every one over the same body.
//
// Browser-safe.

/** Each chip's label, by instance id. */
export type ChipLabels = ReadonlyMap<string, string>;

function labelsOf(chips: ReturnType<typeof chipsInJSON>, inputs: ChipInputs): Map<string, string> {
  const labels = new Map<string, string>();
  chipRenderings(chips, inputs.styles, inputs.context, inputs.pending).forEach((rendering, index) => {
    // As `renderingsByIid`: of two chips sharing an id, the earlier stands for both.
    if (!labels.has(chips[index].iid)) labels.set(chips[index].iid, rendering.label);
  });
  return labels;
}

/** The labels of every chip in a JSON body, computed from `inputs`. */
export function chipLabels(doc: JSONContent, inputs: ChipInputs): ChipLabels {
  return labelsOf(chipsInJSON(doc), inputs);
}

/** The same for a ProseMirror node. */
export function chipLabelsIn(node: PMNode, inputs: ChipInputs): ChipLabels {
  return labelsOf(chipsIn(node), inputs);
}

/** Whether a JSON node, or a ProseMirror one, is a chip. */
export function isChip(node: { type?: string | { name: string } } | null | undefined): boolean {
  const type = node?.type;
  return (typeof type === "string" ? type : type?.name) === ENTITY_CHIP;
}

/**
 * A chip's display text, from its attributes: its label in `labels`, else the
 * label a cache write materialized onto the node, else nothing.
 */
export function chipDisplayText(attrs: Record<string, unknown> | null | undefined, labels?: ChipLabels): string {
  const computed = typeof attrs?.iid === "string" ? labels?.get(attrs.iid) : undefined;
  if (computed !== undefined) return computed;
  return typeof attrs?.label === "string" ? attrs.label : "";
}

/**
 * `textBetween`'s leaf argument for a derivation that wants `other` for every
 * inline leaf but a chip, which keeps its anchor text. Passing a bare string
 * there would give the chip that string too, and a quote derived that way
 * would not be the one every other anchor stores.
 */
export function anchorLeafText(other: string): (leaf: PMNode) => string {
  return (leaf) => (leaf.type.name === ENTITY_CHIP ? CHIP_ANCHOR_TEXT : other);
}
