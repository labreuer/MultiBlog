import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { chipKind } from "./registry";
import {
  ENTITY_CHIP,
  type ChipContext,
  type ChipInputs,
  type ChipOccurrence,
  type ChipRendering,
  type ChipStyles,
} from "./types";

// docs/ENTITY_CHIPS.md, rule 2 — a rendering is a pure function of the chip,
// the style, the chip context and the doc's order. The same function runs in
// the browser and on both servers, and it never depends on who is looking.

/** What a chip shows when this build doesn't know its kind, or its fields don't pass its kind's validator. */
export const UNKNOWN_CHIP: ChipRendering = { label: "[…]", href: null, postHref: null, status: "unknown" };

/** What a chip shows while its target's record is on its way to the browser. */
export const PENDING_CHIP: ChipRendering = { label: "…", href: null, postHref: null, status: "live" };

/** A chip node's three attributes, read without trusting their types. */
export function chipAttrsOf(attrs: Record<string, unknown> | null | undefined): Omit<ChipOccurrence, "pos"> {
  const data = attrs?.data;
  return {
    kind: typeof attrs?.kind === "string" ? attrs.kind : "",
    iid: typeof attrs?.iid === "string" ? attrs.iid : "",
    data: typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {},
  };
}

/** Every chip in `node`, in doc order, with its position in `node`. */
export function chipsIn(node: PMNode): ChipOccurrence[] {
  const chips: ChipOccurrence[] = [];
  node.descendants((child, pos) => {
    if (child.type.name === ENTITY_CHIP) chips.push({ ...chipAttrsOf(child.attrs), pos });
    return !child.isLeaf;
  });
  return chips;
}

/**
 * The same over ProseMirror JSON, for the paths that hold a cache column and
 * no schema. `pos` is the chip's index among the doc's chips, since JSON has
 * no positions to give.
 */
export function chipsInJSON(doc: JSONContent): ChipOccurrence[] {
  const chips: ChipOccurrence[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === ENTITY_CHIP) chips.push({ ...chipAttrsOf(node.attrs), pos: chips.length });
    node.content?.forEach(walk);
  };
  walk(doc);
  return chips;
}

/**
 * The rendering of every chip in `chips`, in the same order: one pass per
 * chip kind over that kind's chips in doc order, which is what numbering and
 * telling apart two same-labelled entities need.
 */
export function chipRenderings(
  chips: readonly ChipOccurrence[],
  styles: ChipStyles,
  context: ChipContext,
  pending: ChipInputs["pending"] = undefined,
): ChipRendering[] {
  const renderings: ChipRendering[] = chips.map(() => UNKNOWN_CHIP);

  const byKind = new Map<string, number[]>();
  chips.forEach((chip, index) => {
    const indexes = byKind.get(chip.kind);
    if (indexes) indexes.push(index);
    else byKind.set(chip.kind, [index]);
  });

  for (const [name, indexes] of byKind) {
    const kind = chipKind(name);
    if (!kind) continue;
    // A chip whose fields its own kind refuses keeps the placeholder, and is
    // left out of the pass so it can't shift another chip's number.
    const valid: { index: number; data: unknown }[] = [];
    for (const index of indexes) {
      const data = kind.validate(chips[index].data);
      if (data !== null) valid.push({ index, data });
    }
    const rendered = kind.render(
      valid.map((entry) => entry.data),
      kind.parseStyle(styles[name]),
      kind.parseContext(context[name]),
    );
    const waiting = new Set(pending?.[name] ?? []);
    valid.forEach((entry, i) => {
      renderings[entry.index] =
        waiting.size > 0 && kind.targets(entry.data).some((id) => waiting.has(id))
          ? PENDING_CHIP
          : (rendered[i] ?? UNKNOWN_CHIP);
    });
  }
  return renderings;
}

/**
 * The renderings keyed by instance id, for a surface that meets chips one
 * node at a time with no position to go by (the static renderer). Two chips
 * sharing an id is a state the editor repairs at once; until it has, the
 * earlier one's rendering stands for both.
 */
export function renderingsByIid(
  chips: readonly ChipOccurrence[],
  renderings: readonly ChipRendering[],
): Map<string, ChipRendering> {
  const map = new Map<string, ChipRendering>();
  chips.forEach((chip, index) => {
    if (!map.has(chip.iid)) map.set(chip.iid, renderings[index]);
  });
  return map;
}

/** Every record id the chips' renderings read, per chip kind: what a context loader is asked for. */
export function chipTargets(chips: readonly ChipOccurrence[]): Record<string, string[]> {
  const targets: Record<string, Set<string>> = {};
  for (const chip of chips) {
    const kind = chipKind(chip.kind);
    const data = kind?.validate(chip.data) ?? null;
    if (!kind || data === null) continue;
    const ids = (targets[chip.kind] ??= new Set());
    for (const id of kind.targets(data)) ids.add(id);
  }
  return Object.fromEntries(Object.entries(targets).map(([name, ids]) => [name, [...ids]]));
}

/**
 * What each chip in a JSON body stands for, in doc order: its chip kind and
 * that kind's identity. Two bodies with equal lists hold the same entities in
 * the same places, whatever their labels or instance ids. A chip this build
 * can't validate is told apart by its raw fields.
 */
export function chipIdentities(doc: JSONContent): string[] {
  return chipsInJSON(doc).map(chipIdentity);
}

/** One chip's identity: its chip kind and what that kind says it points at. */
export function chipIdentity(chip: Pick<ChipOccurrence, "kind" | "data">): string {
  const kind = chipKind(chip.kind);
  const data = kind?.validate(chip.data) ?? null;
  return `${chip.kind}:${kind && data !== null ? kind.identity(data) : JSON.stringify(chip.data)}`;
}

/** The identities of the chips inside a range of `node`, in order: what a conflict check compares beside the text. */
export function chipIdentitiesBetween(node: PMNode, from: number, to: number): string[] {
  const found: string[] = [];
  node.nodesBetween(from, to, (child, pos) => {
    if (child.type.name === ENTITY_CHIP && pos >= from && pos < to) found.push(chipIdentity(chipAttrsOf(child.attrs)));
    return !child.isLeaf;
  });
  return found;
}

/**
 * Each chip's Markdown, by instance id (docs/ENTITY_CHIPS.md, MCP item 1):
 * its chip kind's own syntax, from the same doc-order pass the labels come
 * from. A chip this build can't render reads as the placeholder a tab shows,
 * as plain text, which no parse reads back as a chip.
 */
export function chipMarkdowns(chips: readonly ChipOccurrence[], styles: ChipStyles, context: ChipContext): Map<string, string> {
  const renderings = chipRenderings(chips, styles, context);
  const out = new Map<string, string>();
  chips.forEach((chip, index) => {
    if (out.has(chip.iid)) return;
    const kind = chipKind(chip.kind);
    const data = kind?.validate(chip.data) ?? null;
    out.set(
      chip.iid,
      kind && data !== null ? kind.markdown(data, renderings[index], kind.parseContext(context[chip.kind])) : renderings[index].label.replace(/[\\[\]]/g, "\\$&"),
    );
  });
  return out;
}
